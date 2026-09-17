# Security Model

## Trust boundaries

Pi Remote separates the machine control plane from Pi session content.

### Session content

Pi Collab remains responsible for session confidentiality and control authorization. The remote client must preserve Collab's existing end-to-end encrypted transport semantics.

Normal transcript, tool output, prompts, thinking, and subagent traffic must not be proxied through Pi Remote Relay.

### Machine control

`pi-remote-host` exposes only narrow machine/session operations through an outbound connection to Pi Remote Relay.

The control plane may:

- announce machine presence
- enumerate Pi Collab sessions
- issue a generation-bound Collab capability
- later start/resume/stop explicitly authorized sessions

It must not become a generic remote shell or arbitrary filesystem API.

## Network exposure

The Pi agent and `pi-remote-host` do not require a public inbound port.

Canonical topology:

```text
pi-remote-host -> authenticated outbound WSS -> Pi Remote Relay <- WSS <- iPhone
```

LAN, Tailscale, and Cloudflare Tunnel may exist for development or emergency access, but they are not the trust model and must not weaken application-layer authentication.

The public relay is an Internet-facing service and must treat every connection as untrusted until authenticated.

## Identities and secrets

### iOS

Store in Keychain:

- device private key / paired-device credential
- relay/account credential as appropriate
- trusted machine identity/fingerprint metadata when needed
- Collab capability material only for the minimum reconnect lifetime

Do not store these in `UserDefaults`, analytics, or application logs.

### Host

Store with owner-only permissions:

- stable machine private identity
- pairing state / authorized device public identities
- short-lived relay credentials
- push credentials if later enabled

The current development implementation stores only a non-secret stable machine ID under the user's config directory and uses a bootstrap bearer token from the environment. That bootstrap token is **development-only**.

Never copy provider API keys, SSH keys, browser cookies, MCP credentials, or full environment variables into Pi Remote Relay.

## Relay knowledge

The relay needs only enough information to route the control plane:

- machine ID/name/platform/capabilities
- online/offline presence
- device/account routing identity
- request IDs and operation names
- session discovery metadata required by the UI

The relay must not log:

- Collab URLs
- room keys
- write tokens
- prompts or assistant content
- tool output
- provider credentials
- full environment variables

### Collab capability delivery

Development protocol v0 currently allows a `collabUrl` to pass through relay memory as part of a response so the vertical slice can be proven.

This is not the desired production boundary.

Before production use, capability delivery should be encrypted to the paired device so the relay routes opaque ciphertext and cannot reuse the Collab capability.

## Pairing

Production pairing should require explicit local/physical approval on the host.

Recommended shape:

1. host creates a short-lived pairing challenge;
2. host displays a QR code containing relay identity, machine identity/fingerprint, nonce, and ephemeral public material;
3. iPhone creates its device keypair and scans the challenge;
4. pairing messages travel through the relay but are cryptographically bound to the host/device keys;
5. host explicitly approves and records the device public identity;
6. subsequent control requests use short-lived authenticated sessions bound to that device identity.

Do not put a permanent bearer credential in the QR code.

The development bootstrap bearer token exists only to bring up the first relay/host/iOS vertical slice and must be removed from the production pairing flow.

## Authorization

Initial role: `owner`.

The owner may:

- observe authorized machine presence
- list active Pi sessions
- obtain a Collab control/view link for an explicitly selected session generation
- later start/resume/stop sessions

Authorization is by machine/device identity, not by possession of an IP address, VPN membership, or knowledge of a relay URL.

Every link request must include the generation observed during discovery. If the host has rotated rooms, it returns `stale_generation`.

## Host authoritative state

Disconnecting the phone or relay does not stop Pi.

After reconnection:

1. mobile re-authenticates to the relay;
2. refreshes machine presence;
3. refreshes session metadata;
4. reconnects through Pi Collab;
5. accepts the authoritative session snapshot.

No security or correctness property may depend on a mobile socket staying alive.

## Revocation

A paired device must be revocable without rotating Pi provider credentials.

Revocation should invalidate:

- future relay/control-plane authorization for that device;
- device-bound session/control credentials;
- future Collab capability issuance.

An already-issued Collab capability follows upstream Pi Collab semantics. Immediate revocation may require rotating/stopping that Collab room.

## Logging

Allowed operational logs should be limited to data such as:

- timestamps
- opaque machine/device IDs
- operation name
- session instance ID and generation where required
- success/failure code
- connection lifecycle events

Never log secret capability values or session content.

## Threats explicitly out of scope for MVP

- fully compromised host computer
- fully compromised/jailbroken iPhone with key extraction capability
- malicious Pi tools already authorized by the user
- relay traffic metadata anonymity

These boundaries do not justify weakening transport, authentication, or secret handling.
