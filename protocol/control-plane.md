# Pi Remote Relay / Control Plane v0

Pi Remote Relay is a narrow authenticated router for trusted machines and devices. It does **not** carry normal Pi transcript/tool streaming.

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
  "access": "control"
}
```

The generation is mandatory. A changed Pi Collab room must fail with `stale_generation`.

Current successful link payload still contains:

```json
{
  "op": "sessions.link",
  "instanceId": "...",
  "generation": 3,
  "access": "control",
  "collabUrl": "https://.../#..."
}
```

This capability is still plaintext to the Relay in v0. The next security layer will encrypt it Host-to-device using the paired X25519 keys.

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

## Heartbeat and reconnect

WebSocket ping/pong maintains connection liveness. Pi work continues independently of Relay or mobile connectivity.

After reconnect, both Host and iPhone must re-authenticate using fresh challenges and resubmit their current authorization state.

## Non-goals

This protocol does not define:

- transcript/token streaming
- Pi tool-call/result frames
- subagent frames
- arbitrary shell execution
- generic filesystem access

Those belong to Pi Collab or future narrowly scoped Host operations.
