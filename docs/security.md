# Security Model

## Trust boundaries

Pi Remote separates device control from session content.

### Session content

Pi Collab remains responsible for session confidentiality and control authorization. The remote client must preserve Collab's existing end-to-end encrypted transport semantics and must never send room keys or write tokens to analytics, logs, crash reports, URLs handled by third-party SDKs, or the device control plane.

### Device control

`pi-remote-host` exposes only a narrow authenticated control API. Pairing grants a device identity; it does not grant arbitrary command execution.

## Secrets

Store on iOS Keychain:

- paired-host device credential
- host public identity/fingerprint as needed
- Collab room material only for the lifetime/persistence policy required to reconnect

Never store secrets in `UserDefaults` or application logs.

Store on host with owner-only permissions:

- host device private key / pairing secret
- paired-device public identities / revocation metadata
- push credentials if later enabled

Do not copy Pi provider API keys into Pi Remote.

## Network exposure

The Pi agent itself must not listen on a public TCP port for this product.

Acceptable initial exposure:

- `pi-remote-host` bound to loopback and published through authenticated private ingress, or
- a future outbound host connection to a relay/control service.

The Collab relay sees only what the upstream Collab protocol intentionally exposes and must not receive plaintext transcript content.

## Pairing

MVP pairing should require explicit physical/local approval on the host. A recommended flow:

1. host creates a short-lived pairing challenge;
2. host displays QR code containing endpoint, host identity fingerprint, nonce, and ephemeral public material;
3. iPhone scans it and creates its device keypair;
4. both sides authenticate the handshake and derive/register the device identity;
5. host records the paired device;
6. subsequent control-plane calls use mutually authenticated signed challenges or a short-lived token bound to that device key.

Do not use a permanent bearer token embedded directly in a QR code.

## Authorization

Start with one role: `owner`.

The owner may:

- list active Pi sessions
- obtain a Collab control link for an explicitly selected session generation
- later start/resume/stop sessions

Every action must be explicit and auditable. Generating a control link should use the generation observed during discovery so a stale mobile selection cannot silently attach to a replacement session.

## Logging

Host logs may contain:

- timestamps
- device identifier/friendly name
- action names
- session instance ID and generation
- success/failure codes

Host logs must not contain:

- Collab room keys
- write tokens
- prompts or assistant content
- provider credentials
- full environment variables

## Revocation

The host must support revoking a paired iPhone without rotating Pi credentials. Revocation invalidates future control-plane authentication and any host-issued reconnect credentials. Existing Collab links should be treated according to upstream Collab semantics; MVP can require stopping/rotating a room when immediate session revocation is needed.

## Threats explicitly out of scope for MVP

- a fully compromised host computer
- a fully compromised/jailbroken iPhone with Keychain extraction capability
- malicious Pi tools already authorized by the user
- anonymity of relay traffic metadata

These do not justify weakening transport or credential handling, but they are not solvable by the remote client itself.
