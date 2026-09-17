# Architecture

## Goal

Pi Remote should feel like a native remote agent client rather than a remote terminal. The host computer owns the Pi process and all machine access; the iPhone owns presentation and user interaction.

## Two planes

### 1. Session data plane — Pi Collab

Reuse Pi/OMP Collab for live session replication and control:

- transcript snapshot and incremental updates
- assistant streaming
- thinking and tool activity
- prompt submission
- interrupt
- interactive questions
- subagent state/control where supported
- encrypted WebSocket transport

The mobile app should not invent a second transcript protocol when Collab already carries authoritative session state.

### 2. Device control plane — pi-remote-host

A small daemon/service on the computer supplies capabilities that Collab intentionally does not provide as a remote product:

- device pairing and trust establishment
- host reachability/presence
- enumerate active local Collab hosts
- request a control/view link for a selected host generation
- later: create, resume, fork, stop, and name sessions
- later: workspace and model metadata
- later: push-notification bridge

The control plane must not proxy shell commands or arbitrary filesystem access. Those remain inside Pi and its normal permission model.

## Initial topology

```text
iOS app
  |
  | control-plane HTTPS/WSS (paired device credential)
  v
pi-remote-host
  |
  | local-only registry / CLI integration
  v
Pi Collab host registry

Once a session is selected:

iOS app <==== E2EE Collab WebSocket ====> relay <==== E2EE ====> Pi session
```

The control plane can initially be reached through an existing private ingress such as Cloudflare Tunnel. Long term, relay-backed host presence may remove the need for inbound connectivity to the host.

## Host integration

The first implementation should prefer Pi's supported local interfaces over parsing terminal output:

- `omp collab list --json` for discovery
- `omp collab link <instanceId> --json` for a generation-bound URL

If a stable local IPC API becomes available, the host service can adopt it without changing the iOS-facing protocol.

## iOS architecture

Suggested modules:

```text
PiRemoteApp
  AppState
  Pairing
  Hosts
  Sessions
  Conversation
  Transport
    ControlPlaneClient
    CollabClient
  Security
    KeychainStore
  UI
    HostListView
    SessionListView
    ConversationView
    ComposerView
```

Use Swift concurrency (`async/await`, actors) for connection state. The Collab connection owner should be an actor so reconnects, received frame ordering, and application lifecycle transitions are serialized.

## State ownership

The host is authoritative for:

- whether a session exists
- session generation
- Pi runtime state
- transcript contents
- running/idle status
- interactive requests

The iOS app may cache state for fast launch, but cached state must be reconciled after reconnect.

## Background behavior

iOS may suspend the app and close sockets. The design therefore assumes disconnects are routine:

1. persist only non-secret presentation state and encrypted/keychain credentials as appropriate;
2. on foreground, reconnect to the control plane;
3. re-resolve the selected session generation;
4. reconnect through Collab;
5. request/accept the current authoritative snapshot;
6. replace or reconcile cached UI state;
7. continue streaming without restarting the Pi task.

No correctness property may depend on a mobile WebSocket staying alive while the app is backgrounded.

## MVP boundary

The first vertical slice deliberately excludes generic remote shell, arbitrary host file browsing, multi-user sharing, and background execution on iOS. It proves one secure path:

**paired iPhone -> discover active Pi session -> connect -> render -> prompt -> interrupt -> reconnect**.
