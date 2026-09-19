# Pi Remote Relay / Control Plane v0

Pi Remote Relay is a narrow authenticated router for trusted machines and devices. It routes authenticated control-plane messages and opaque end-to-end encrypted Pi RPC frames. The Relay does not interpret Pi transcript, tool, reasoning, or extension-UI payloads.

## Transport

Canonical topology:

```text
pi-remote-host -> WSS -> Pi Remote Relay <- WSS <- iPhone
```

Both sides initiate outbound WebSocket connections. Public deployment requires TLS/WSS.

LAN, Tailscale, or Cloudflare may exist as development/fallback transports, but network reachability is never authorization.

## Security layers

The control plane uses four separate checks:

1. **connection authentication** — prove possession of the machine/device Ed25519 private key;
2. **machine authorization grant** — prove the Host paired this device;
3. **live Host authorization snapshot** — prove the device has not since been revoked;
4. **per-request device signature** — prove each control operation actually came from the paired device.

The Relay cannot manufacture layer 4 because it never has the device private key.

## 1. Connection authentication

Immediately after WebSocket upgrade the Relay sends:

```json
{
  "protocolVersion": 0,
  "type": "auth.challenge",
  "challengeId": "auth_...",
  "role": "client",
  "nonce": "...",
  "expiresAt": "2026-09-18T00:00:30.000Z"
}
```

For a Host, `role` is `host`.

The connecting peer signs a domain-separated canonical message containing:

- role
- challenge ID
- nonce
- principal kind
- principal ID
- principal signing public key

Client response:

```json
{
  "protocolVersion": 0,
  "type": "auth.response",
  "challengeId": "auth_...",
  "principal": {
    "kind": "device",
    "id": "device_...",
    "signingPublicKey": "..."
  },
  "signature": "..."
}
```

Host uses `kind: "machine"`.

The challenge is random, short-lived, connection-bound, and accepted only once by the server state machine.

On success the Relay sends `auth.accepted`. No shared bootstrap bearer token is part of the canonical connection protocol.

## 2. Hello

After authentication, Host announces only public machine fields:

```json
{
  "protocolVersion": 0,
  "type": "host.hello",
  "machine": {
    "id": "machine_...",
    "name": "omarchy",
    "platform": "linux",
    "capabilities": ["sessions.list", "sessions.link"],
    "signingPublicKey": "...",
    "keyAgreementPublicKey": "...",
    "fingerprint": "..."
  }
}
```

The machine ID and signing public key must match the authenticated principal.

Client hello:

```json
{
  "protocolVersion": 0,
  "type": "client.hello",
  "device": {
    "id": "device_...",
    "name": "iPhone",
    "signingPublicKey": "...",
    "keyAgreementPublicKey": "..."
  }
}
```

The device ID and signing public key must match the authenticated principal.

## 3. MachineGrant authorization

Pairing returns a Host-signed `MachineGrant`:

```json
{
  "version": 1,
  "grantId": "grant_...",
  "machine": {
    "id": "machine_...",
    "signingPublicKey": "...",
    "keyAgreementPublicKey": "..."
  },
  "device": {
    "id": "device_...",
    "signingPublicKey": "...",
    "keyAgreementPublicKey": "..."
  },
  "role": "owner",
  "issuedAt": "2026-09-18T00:00:00.000Z",
  "signature": "host Ed25519 signature"
}
```

The iPhone stores valid grants in Keychain and sends them after hello:

```json
{
  "protocolVersion": 0,
  "type": "client.authorizations",
  "grants": []
}
```

The Relay verifies:

- Host signature on each grant;
- grant device ID equals the authenticated device;
- grant device signing key equals the authenticated device signing key;
- grant key-agreement key equals the current device key.

A grant is necessary but not sufficient.

## 4. Live Host authorization

After hello the Host sends its currently active paired-device set:

```json
{
  "protocolVersion": 0,
  "type": "host.authorization_snapshot",
  "machineId": "machine_...",
  "devices": [
    {
      "id": "device_...",
      "signingPublicKey": "...",
      "keyAgreementPublicKey": "...",
      "role": "owner"
    }
  ]
}
```

The Relay considers a machine visible/routable only when:

```text
valid MachineGrant
AND
matching authenticated Host key
AND
device is present in current Host authorization snapshot
```

This means an old signed grant cannot override Host revocation.

A Host using the same `machineId` with a different signing key is a different cryptographic identity and cannot receive traffic for the trusted grant.

## Machine snapshot / presence

After authorization state changes, the Relay sends only machines the current device is authorized to access:

```json
{
  "protocolVersion": 0,
  "type": "machines.snapshot",
  "machines": [
    {
      "id": "machine_...",
      "name": "omarchy",
      "platform": "linux",
      "capabilities": ["sessions.list", "sessions.link"],
      "signingPublicKey": "...",
      "keyAgreementPublicKey": "...",
      "fingerprint": "...",
      "online": true
    }
  ]
}
```

Incremental `machine.presence` frames may also be emitted.

## Per-request authorization

Every control request is signed by the iPhone device key.

```json
{
  "protocolVersion": 0,
  "type": "control.request",
  "requestId": "req_...",
  "machineId": "machine_...",
  "payload": {
    "op": "sessions.list"
  },
  "authorization": {
    "deviceId": "device_...",
    "issuedAtMs": 1800000000000,
    "signature": "device Ed25519 signature"
  }
}
```

The signature covers a domain-separated, operation-specific canonical message containing:

- request ID
- machine ID
- device ID
- issuance time
- operation
- operation-specific arguments

For `sessions.link`, the signed arguments include:

- instance ID
- generation
- requested access
- optional `resumeFromHostSeq` cursor

The resume cursor is therefore authenticated by the paired device signature and cannot be changed by the Relay without invalidating the request.

The Relay binds `authorization.deviceId` to the authenticated connection.

The Host independently verifies:

- device is still active in its local authorization store;
- signature matches the stored device signing key;
- machine ID matches this Host;
- issuance time is within the accepted skew window;
- request ID has not already been accepted in the replay cache.

Therefore compromise of the Relay alone does not allow it to invent Host control operations.

## Operations

### sessions.list

```json
{
  "op": "sessions.list"
}
```

### sessions.link

```json
{
  "op": "sessions.link",
  "instanceId": "...",
  "generation": 3,
  "access": "control",
  "resumeFromHostSeq": 1845
}
```

`resumeFromHostSeq` is omitted for a normal first open and included when an existing mobile RPC client resumes a live Host channel.

The generation is mandatory. A changed Pi session must fail with `stale_generation`.

A successful link response contains only an encrypted capability envelope:

```json
{
  "op": "sessions.link",
  "instanceId": "...",
  "generation": 3,
  "access": "control",
  "capability": {
    "version": 1,
    "algorithm": "X25519-HKDF-SHA256-AES-256-GCM",
    "machineId": "machine_...",
    "deviceId": "device_...",
    "requestId": "req_...",
    "instanceId": "...",
    "generation": 3,
    "access": "control",
    "salt": "...",
    "nonce": "...",
    "ciphertext": "...",
    "tag": "..."
  }
}
```

The plaintext `collabUrl` is never placed in the Relay response.

The Host derives an X25519 shared secret using its machine key-agreement private key and the authorized device's stored X25519 public key. It then derives an AES-256 key with HKDF-SHA256 using a fresh 32-byte salt.

The HKDF info and AES-GCM AAD are the same domain-separated canonical context containing:

- machine ID
- device ID
- request ID
- session instance ID
- session generation
- requested access

AES-GCM uses a fresh 12-byte nonce.

The iPhone decrypts only after finding a locally verified MachineGrant whose machine signing and X25519 public keys exactly match the online machine identity. It uses the machine X25519 key from that trusted grant identity, not an arbitrary key supplied by the Relay.

Consequences:

- Relay cannot read the Collab URL, room key, or write token;
- Relay cannot alter machine/device/request/session/access context without authentication failure;
- a different paired device cannot decrypt the envelope;
- replay into a different request or generation is rejected by context checks and AEAD.

The scheme uses long-lived paired X25519 identities and therefore does not claim forward secrecy if a long-lived X25519 private key is later compromised.

## Response envelope

```json
{
  "protocolVersion": 0,
  "type": "control.response",
  "requestId": "req_...",
  "machineId": "machine_...",
  "ok": true,
  "payload": {}
}
```

Errors include:

- `unauthorized`
- `forbidden`
- `machine_offline`
- `not_found`
- `stale_generation`
- `host_registry_unavailable`
- `pi_command_failed`
- `unsupported_access`
- `invalid_request`
- `timeout`
- `internal_error`

## RPC sequence, replay, and reconnect

Each encrypted Host-to-device `rpc.frame` has a monotonically increasing per-channel sequence number authenticated as AES-GCM AAD.

The iPhone applies Host frames only when they are contiguous:

```text
expected = lastHostSeq + 1
frame.seq == expected
```

Older/duplicate frames are ignored. A forward gap triggers transport recovery rather than silently skipping an event.

The Host retains a bounded in-memory ring of already-encrypted Host frames for each live Pi RPC channel. Current defaults are:

- at most 2,048 frames;
- at most 8 MiB;
- no persistence to Relay or disk.

On resume the iPhone sends its signed `resumeFromHostSeq`. If the ring still covers that cursor, the Host returns the existing channel capability with replay metadata and sends exactly the missing encrypted frames.

A **resume barrier** prevents new Pi output from overtaking replay:

```text
iPhone lastHostSeq=N
        |
        | signed sessions.link(resumeFromHostSeq=N)
        v
Host freezes live delivery at target=T
        |
        +-- control.response(capability, target=T)
        +-- replay N+1 ... T
        |
iPhone verifies contiguous replay
        |
        | E2EE piremote.resume_ack(target=T)
        v
Host releases frames generated after T
```

The barrier also protects initial links so a fast Pi process cannot emit `ready` before the phone has created its `PiRpcClient`.

If the requested cursor is older than the retained ring, the capability reports `replayAvailable=false`. The phone advances to the barrier baseline, clears transient partial-message assembly, ACKs the barrier, and repairs durable state from Pi with `get_state`, `get_messages`, and `get_available_models`.

Replay is therefore an optimization for lossless short disconnects, while Pi/Host authoritative state remains the correctness fallback for longer disconnects.

WebSocket ping/pong maintains connection liveness. Pi work continues independently of Relay or mobile connectivity. After reconnect, both Host and iPhone re-authenticate using fresh challenges and resubmit current authorization state.

## Non-goals

This protocol does not define the semantic schema of:

- transcript/token content;
- Pi tool-call/result payloads;
- subagent payloads;
- arbitrary shell execution;
- generic filesystem access.

Pi's native RPC protocol defines agent semantics. Pi Remote only wraps those payloads in an authenticated, sequenced, replayable E2EE transport.
