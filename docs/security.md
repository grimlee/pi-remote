# Security Model

## Core rule

The Relay is a router, not the root of trust.

A compromised or curious Relay may observe routing metadata or deny service, but it should not be able to forge a paired-device control request, decrypt Pi RPC contents, or obtain Host provider credentials.

Quick Connect does not change this rule. Tailcat provides reachability only.

## Trust boundaries

### Host

The Host owns:

- machine Ed25519 signing private key;
- machine X25519 key-agreement private key;
- paired-device authorization/revocation state;
- Pi RPC processes and channel keys;
- Pi runtime, files, tools, and provider credentials.

### iPhone

The iPhone owns:

- device Ed25519 signing private key;
- device X25519 key-agreement private key;
- Host-signed MachineGrants.

Private device material and grants are stored in Keychain using this-device-only accessibility.

### Relay

The Relay may know:

- public machine/device identities;
- online/offline presence;
- Host-signed MachineGrants;
- current Host authorization snapshots;
- request IDs and operation metadata;
- session discovery metadata such as session/workspace identifiers;
- RPC routing metadata such as channel ID, direction, and sequence number.

The Relay must not receive provider API keys, SSH keys, browser cookies, MCP credentials, arbitrary Host environment secrets, or plaintext Pi RPC payloads.

### Tailcat

Tailcat is a network underlay.

A Tailcat address is sensitive reachability information and should not be published, but possession of that address is **not** sufficient Pi Remote authorization.

Normal control still requires the paired device identity, valid Host grant, live Host authorization, and valid request/channel cryptography.

## Connection authentication

Host and client Relay WebSockets use short-lived Relay challenges.

Each peer proves possession of its Ed25519 private key. The signed challenge binds role, nonce, principal type, principal ID, and signing public key.

There is no long-lived shared bearer token in the canonical Pi Remote authentication flow.

For a public Relay deployment, WSS/TLS is still required to protect server identity and metadata against trivial active interference.

For Quick Connect, the WebSocket terminates at the Host-local Relay through the Tailcat transport.

## Pairing

Pairing uses:

- a short-lived single-use QR secret;
- HMAC proof of possession of that secret;
- device Ed25519 proof of possession;
- Host-signed acceptance;
- Host-signed MachineGrant.

The QR is bootstrap material, not a permanent login token.

After first pairing, later normal reconnects use the stored device identity and grant rather than requiring another scan.

## Authorization

A MachineGrant binds:

~~~text
machine cryptographic identity
        +
device cryptographic identity
        +
role
~~~

The Relay verifies the signed grant, but a grant alone is not irrevocable authority.

The authenticated Host also publishes its current active-device authorization snapshot. A device is routable only while the signed grant and Host live authorization state agree.

This preserves Host-authoritative revocation.

## Per-request device signatures

Every control request carries a device Ed25519 signature over an operation-specific canonical message.

The Host independently verifies:

- the device is still locally authorized;
- request signature;
- target machine identity;
- issuance time window;
- request-ID replay cache;
- operation-specific arguments.

The Relay cannot manufacture a fresh valid Host control request without the iPhone private signing key.

## Machine impersonation

A machine ID by itself is not identity.

Grants bind the opaque machine ID to the Host signing/key-agreement public keys. A different machine key claiming the same string ID cannot satisfy the trusted grant.

## Pi RPC capability delivery

For a session link the Host creates or reuses a Pi RPC channel containing sensitive material such as:

- channel ID;
- symmetric channel key;
- sequence/replay state;
- resume barrier metadata.

That capability is encrypted specifically to the paired iPhone using:

- X25519 shared secret from Host/device identities;
- HKDF-SHA256;
- AES-256-GCM;
- fresh salt and nonce;
- authenticated context binding machine, device, request, session generation, and access.

Only the encrypted capability envelope crosses the Relay.

The iPhone decrypts it only against the exact Host identity already trusted by its MachineGrant.

The long-lived paired-X25519 construction does not claim forward secrecy if a long-lived Host or device private key is later compromised.

## Pi RPC payload encryption

Pi Remote does not send native Pi RPC JSON to the Relay in plaintext.

The Host wraps Pi RPC commands/events in per-channel AES-GCM encrypted \`rpc.frame\` messages.

Authenticated routing context includes:

- machine ID;
- device ID;
- channel ID;
- direction;
- monotonically increasing sequence number.

The Relay forwards the encrypted frame without interpreting prompt, assistant, thinking, tool, or extension-UI contents.

## Replay and ordering

Host->phone frames are applied only in contiguous sequence order.

The Host keeps a bounded in-memory encrypted replay ring. A real reconnect can request missing frames from the last successfully applied Host sequence.

A resume barrier prevents newly generated Pi output from overtaking replay.

If the replay ring no longer covers the requested cursor, Pi Remote repairs durable state through native Pi RPC authoritative queries instead of applying a partial history.

Replay state is not persisted to the Relay.

## Reliable client commands

The iPhone keeps a bounded in-memory journal for reliability-sensitive commands.

The Host acknowledges accepted client sequence numbers. During transport recovery, the Host's next expected sequence is authoritative for deciding whether a command was already delivered or must be resent.

This is especially important for prompt submission, where accidental duplicate delivery is unacceptable.

## Revocation

Host revocation is authoritative.

Revoking a device:

- removes it from the Host authorization snapshot;
- causes future signed control requests to fail;
- prevents issuance of new Pi RPC capabilities.

Revocation does not require rotating provider credentials, machine identity, or other trusted device identities.

## Storage

Host identity and authorized-device records are owner-only.

iOS private identity, grants, and paired Host profile are stored in Keychain.

Runtime logs and diagnostics must not contain:

- private keys;
- pairing QR payloads;
- Tailcat private key/address material;
- provider/API credentials;
- raw private session files.

The Quick Connect launcher writes trace files under \`.runtime/\`, which is gitignored. Users should still review logs before sharing them publicly.

## Local conversation cache

The iOS presentation cache may contain conversation text.

It is an accelerator, not an authority. Users should treat the device/app data as containing potentially sensitive work content.

The cache does not contain Host provider credentials.

## Public Relay / Cloudflare deployment

A public Relay is an optional advanced/fallback topology.

The Host still initiates outbound connectivity, so the Host does not need a directly exposed inbound port.

Do not place an interactive browser login flow in front of the Relay WebSocket. Pi Remote performs its own cryptographic authentication.

## Threats outside the current scope

Pi Remote does not attempt to protect against:

- a fully compromised Host OS;
- a fully compromised/jailbroken iPhone with extracted Keychain material;
- malicious Pi tools already authorized to run by the user;
- traffic-metadata analysis;
- denial of service by the Relay or network;
- disclosure caused by a user publishing sensitive logs/session files.
