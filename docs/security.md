# Security Model

## Core rule

The Relay is a router, not the root of trust.

Pi Remote must remain safe against a Relay that is curious or partially compromised. A compromised Relay may observe control-plane metadata and cause denial of service, but it should not be able to manufacture a valid paired-device control request or obtain provider credentials.

## Trust boundaries

### Host

The Host owns:

- machine Ed25519 signing private key;
- machine X25519 key-agreement private key;
- paired-device authorization/revocation state;
- Pi runtime and local credentials.

### iPhone

The iPhone owns:

- device Ed25519 signing private key;
- device X25519 key-agreement private key;
- Host-signed MachineGrants.

Private device material and grants are stored in Keychain with this-device-only accessibility.

### Relay

The Relay may know:

- public machine/device identities;
- online/offline state;
- Host-signed MachineGrants;
- current Host authorization snapshots;
- request IDs and operation metadata;
- session discovery metadata.

The Relay must never receive provider API keys, SSH keys, browser cookies, MCP credentials, full environment variables, or arbitrary Host filesystem access.

## Connection authentication

Host and client WebSockets use short-lived Relay challenges.

Each side proves possession of its Ed25519 private key. The signed challenge is domain-separated and binds role, nonce, principal type, principal ID, and signing public key.

There is no shared bearer token in the canonical authentication flow.

Public deployment requires WSS/TLS even though device/Host identity is cryptographically authenticated, because TLS still protects metadata and server identity and prevents trivial active network interference.

## Authorization

Pairing produces a Host-signed MachineGrant binding:

```text
machine public identity
        +
device public identity
        +
role
```

The Relay verifies the grant but does not treat it as irrevocable authority.

The authenticated Host also publishes its current active-device authorization snapshot. A request is routable only if the signed grant and live Host snapshot agree.

This preserves Host-authoritative revocation.

## Per-request device signatures

Relay-level routing checks are not sufficient because a compromised Relay could otherwise invent requests toward the Host.

Every control request therefore carries a device Ed25519 signature over an operation-specific canonical message.

The Host independently verifies:

- local paired-device state;
- request signature;
- target machine ID;
- issuance time window;
- request-ID replay cache.

The Relay cannot forge a new request without the iPhone private key.

A Relay may replay a previously observed signed request, so the Host rejects duplicate request IDs and stale timestamps. The in-memory replay cache is bounded by the acceptance window; persistent replay protection across an immediate Host restart may be added if later threat modeling requires it.

## Machine impersonation

A `machineId` is not sufficient identity.

Relay routing binds a grant to the machine Ed25519 signing public key. A connection claiming the same opaque machine ID with another key cannot receive requests authorized for the trusted machine key.

## Pairing

Pairing uses:

- short-lived single-use QR secret;
- HMAC proof of possession of that secret;
- device Ed25519 proof of possession;
- Host-signed acceptance and MachineGrant.

The QR does not contain a permanent bearer credential.

## Revocation

A device can be revoked without rotating:

- provider credentials;
- machine identity;
- other device identities;
- network configuration.

Revocation removes the device from the Host live authorization snapshot and causes future Host control signature checks to fail.

Already-issued Pi Collab capabilities follow upstream Collab semantics until their room/generation rotates. The next layer will make newly issued Collab capabilities Host-to-device encrypted.

## Collab capability delivery

Pi Collab capabilities are end-to-end encrypted from the Host to the paired iPhone before entering the Relay.

The Host briefly receives the plaintext `collabUrl` from the local `omp collab link` command, then immediately encrypts it using:

- X25519 shared secret from the machine private key and authorized device public key;
- HKDF-SHA256 with a fresh 32-byte salt;
- AES-256-GCM with a fresh 12-byte nonce.

The authenticated context binds machine ID, device ID, control request ID, session instance ID, generation, and access level. The same context is used as HKDF info and AES-GCM AAD.

Only the encrypted envelope crosses Pi Remote Relay. The Relay can still observe routing/session metadata such as instance ID, generation, and requested access, but cannot recover the Collab URL, room key, or write token.

The iPhone will decrypt only when the online machine cryptographic identity exactly matches a locally verified Host-signed MachineGrant.

A malicious Relay can drop or replay ciphertext, but it cannot:

- decrypt the capability;
- retarget it to another device;
- change generation/access/request context without AES-GCM failure;
- forge a new valid capability without the Host X25519 private key.

This static paired-X25519 construction does **not** provide forward secrecy against later compromise of a long-lived Host or device X25519 private key. If that threat becomes material, capability delivery can evolve to an authenticated ephemeral key exchange without changing the Relay routing model.

## Session data

Normal Pi transcript, assistant streaming, tool output, prompts, and subagent traffic stay on Pi Collab's end-to-end encrypted data plane. Pi Remote Relay does not duplicate that protocol.

## Storage

Host private identity files and authorization records are owner-only.

iOS private identity and MachineGrants are stored in Keychain, not `UserDefaults`.

Secrets and capability material must never enter logs, analytics, crash breadcrumbs, or telemetry.

## Network exposure

The Host requires no public inbound port:

```text
pi-remote-host -> WSS Relay <- WSS iPhone
```

LAN/Tailscale/Cloudflare may be debugging fallbacks, never authorization signals.

## Out of scope for MVP

- fully compromised Host OS;
- fully compromised/jailbroken iPhone with extracted Keychain material;
- malicious Pi tools already explicitly authorized by the user;
- traffic-metadata anonymity;
- protection against Relay denial of service.
