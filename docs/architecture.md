# Architecture

## Goal

Pi Remote should feel like a native remote-agent product, not a remote network utility.

The user should think in terms of:

```text
Trusted machine -> active sessions -> task
```

not:

```text
VPN -> hostname -> port -> server
```

The host computer owns Pi and all machine access. The iPhone owns presentation and user interaction. A lightweight Pi Remote Relay provides rendezvous, presence, authentication, and control-message routing.

## Three components, two planes

### Components

1. **Pi Remote iOS**
   - native SwiftUI control surface
   - trusted machine/session list
   - Pi Collab client
   - local Keychain identity

2. **pi-remote-host**
   - runs beside Pi on the computer
   - owns a stable machine identity
   - maintains an outbound relay connection
   - reads Pi's local Collab registry
   - resolves generation-bound Collab links
   - later starts/resumes/stops sessions

3. **Pi Remote Relay**
   - public rendezvous/control service
   - tracks authenticated machine presence
   - routes narrow request/response messages
   - never needs provider credentials or host filesystem access
   - should not proxy normal Pi session content

### Plane A: machine control plane

```text
pi-remote-host ── outbound WSS ──► Pi Remote Relay ◄── WSS ── Pi Remote iOS
```

Responsibilities:

- machine authentication and presence
- paired-device/account authorization
- session discovery
- generation-bound Collab link requests
- later: start/resume/stop and push metadata

### Plane B: Pi session data plane

```text
Pi session <==== E2EE Pi Collab ====> Collab relay <==== E2EE ====> iPhone
```

Responsibilities remain upstream Pi Collab:

- transcript snapshots and incremental state
- assistant streaming
- thinking/tool activity
- prompt submission
- interrupt
- interactive questions
- subagent state/control where supported

Pi Remote must not invent a second transcript protocol unless upstream Collab cannot express a required product feature.

## Why relay instead of direct host networking

Direct networking solutions such as LAN, Tailscale, SSH forwarding, or Cloudflare Tunnel can make a host reachable, but they expose infrastructure concepts to the user.

Pi Remote's product abstraction is:

```text
machineId = stable identity
status = online/offline
sessions = current Pi sessions
```

The host initiates the relay connection, so normal operation requires no public inbound port, static IP, VPN state, NAT traversal configuration, or hostname entry on the phone.

Tailscale/LAN/Cloudflare remain useful development and emergency transports and should stay behind a transport abstraction.

## Host lifecycle

At startup:

1. load or create a stable machine identity;
2. authenticate to Pi Remote Relay;
3. open an outbound WebSocket;
4. send machine metadata/capabilities;
5. maintain heartbeat/presence;
6. answer control requests by consulting Pi's local interfaces.

If the connection drops, the host reconnects with bounded exponential backoff. Pi sessions continue running independently.

## Session discovery

The host should prefer supported Pi interfaces:

- `omp collab list --json`
- `omp collab link <instanceId> --json`

A discovery response is metadata only. A Collab URL is capability-bearing secret material and is generated only after an authorized request for an exact session generation.

## Generation safety

A phone selects:

```text
(instanceId, generation)
```

not only `instanceId`.

If the Pi process rotates to a new room before link issuance, the request must fail with `stale_generation`. The client then refreshes the session list instead of silently attaching to a replacement session.

## Relay routing model

The relay should route by opaque identities rather than network coordinates:

```text
machineId
deviceId / accountId
requestId
```

A typical flow:

```text
iPhone                    Relay                     Host
  |                         |                         |
  | sessions.list           |                         |
  |------------------------>|                         |
  |                         | control.request         |
  |                         |------------------------>|
  |                         |                         | omp collab list --json
  |                         | control.response        |
  |                         |<------------------------|
  | sessions snapshot       |                         |
  |<------------------------|                         |
```

For a session link:

```text
iPhone                    Relay                     Host
  | link(instance,gen)      |                         |
  |------------------------>|------------------------>|
  |                         |                         | omp collab link ...
  |                         |<------------------------|
  | encrypted capability    |                         |
  |<------------------------|                         |
```

The long-term design should encrypt sensitive capability responses to the paired mobile device so the relay does not need plaintext Collab room material.

## State ownership

The host/Pi environment is authoritative for:

- machine online state while connected
- session existence
- session generation
- Pi runtime state
- transcript contents
- running/idle status
- interactive requests

The relay is authoritative only for ephemeral routing/presence it directly observes.

The iOS app may cache presentation state but must reconcile after reconnect.

## Background behavior

iOS may suspend the app and close sockets. Disconnect is normal:

1. iOS persists only appropriate cached presentation state and Keychain credentials;
2. on foreground, reconnect to relay;
3. refresh machine presence;
4. refresh selected session generation;
5. reconnect through Pi Collab;
6. accept authoritative snapshot;
7. reconcile/replace cached UI state.

No correctness property may depend on the mobile WebSocket surviving background suspension.

## Security boundary

Provider keys, SSH credentials, browser cookies, MCP credentials, filesystem contents, and arbitrary shell execution remain on the host.

The relay receives only the minimum metadata necessary for routing/control. Pi Collab session content remains protected by upstream end-to-end encryption.

Pairing/device authentication is a separate protocol concern from machine/session resource semantics. The initial development relay may use a bootstrap token, but that is not a production identity design.

## iOS architecture

Suggested modules:

```text
PiRemoteApp
  AppState
  Identity
  Pairing
  Machines
  Sessions
  Conversation
  Transport
    RelayClient
    FallbackHostTransport
    CollabClient
  Security
    KeychainStore
  UI
    MachineListView
    SessionListView
    ConversationView
    ComposerView
```

Use Swift concurrency. WebSocket connection owners should be actors so reconnects, frame ordering, and lifecycle transitions are serialized.

## MVP boundary

First production-shaped vertical slice:

**paired iPhone -> relay -> online host -> discover active Pi session -> obtain exact-generation Collab capability -> connect through Collab -> render -> prompt -> interrupt -> reconnect**.

Explicitly excluded from the first slice:

- arbitrary remote shell
- generic filesystem browsing
- multi-user sharing
- iOS background execution guarantees
- running transcript traffic through Pi Remote Relay
