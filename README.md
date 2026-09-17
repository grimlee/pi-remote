# Pi Remote

Native iOS remote control for a Pi / Oh My Pi agent running on your computer.

The goal is a ChatGPT Remote-style experience: the agent and tools stay on the host computer while the iPhone acts as a secure, low-latency control surface for discovering machines and sessions, observing work, steering, interrupting, and answering interactive requests.

## Product principles

- **Native iOS UX** — SwiftUI, native navigation, keyboard handling, haptics, notifications, and background recovery.
- **Host executes everything** — LLM calls, shell commands, filesystem access, MCP tools, browser tools, and subagents remain on the computer.
- **Machine identity, not IP addresses** — users interact with trusted machines and sessions, not hostnames, VPNs, ports, or tunnel URLs.
- **Outbound-only host connectivity** — the host initiates the control-plane connection to Pi Remote Relay; no inbound port is required.
- **Pi Collab remains the session data plane** — transcript replication, live tool state, prompt/interrupt, and E2EE stay on the upstream Collab protocol.
- **Host-authoritative state** — mobile disconnects are routine; reconnecting restores current state without restarting Pi.
- **Transport is replaceable** — Tailscale, LAN, or Cloudflare may exist as development/fallback transports, but they are not the product model.

## Target architecture

```text
                         CONTROL PLANE
       outbound WSS                           WSS
Host computer ───────────────► Pi Remote Relay ◄────────────── iPhone
┌──────────────────────┐      ┌───────────────┐               ┌─────────────┐
│ pi-remote-host       │      │ machine       │               │ Pi Remote   │
│ - machine identity   │      │ presence      │               │ SwiftUI     │
│ - session discovery  │      │ routing       │               │             │
│ - issue Collab link  │      │ auth/pairing  │               │             │
└──────────┬───────────┘      └───────────────┘               └──────┬──────┘
           │                                                          │
           │ local Pi registry                                        │
           ▼                                                          │
     Pi / OMP session                                                  │
           │                                                          │
           └──────────── E2EE Pi Collab data plane ───────────────────┘
                         via Pi Collab relay
```

Pi Remote Relay is deliberately a narrow rendezvous/control service. It should not proxy normal transcript or tool traffic when Pi Collab already provides that channel.

## MVP

1. Register one host machine with a stable machine identity.
2. Keep an outbound host connection to Pi Remote Relay.
3. Pair one iPhone with the host/account identity.
4. Show host online/offline presence without IP configuration.
5. List active Pi Collab sessions through the relay.
6. Request a generation-bound Collab control capability.
7. Connect the iPhone directly to the Pi Collab session.
8. Render transcript and live tool activity.
9. Send prompt / interrupt / answer interactive requests.
10. Reconnect after backgrounding and recover authoritative host/session state.

Later phases add new-session creation, workspace/model controls, file and diff viewers, push notifications, Live Activities, multiple hosts, and richer subagent controls.

## Repository layout

```text
docs/       Architecture and security decisions
host/       Host-side control agent; maintains outbound relay connection
ios/        Native SwiftUI application
protocol/   Pi Remote relay/control-plane protocol
relay/      Minimal Pi Remote control relay
```

## Relationship to Pi Collab

Pi Remote does not replace Pi Collab.

**Pi Remote Relay / pi-remote-host** provide the machine control plane:

- trusted machine identity
- host online/offline presence
- session discovery
- session capability issuance
- later: start/resume/stop and push metadata

**Pi Collab** remains the session data plane:

- transcript snapshot and events
- streaming assistant output
- tool calls/results
- prompt and interrupt
- interactive requests
- subagents
- end-to-end encrypted session content

This split keeps Pi Remote's own relay small and avoids reimplementing Pi's real-time session protocol.

## Connectivity policy

Primary product path:

```text
host -> Pi Remote Relay <- iPhone
```

Development/fallback paths may include LAN, Tailscale, or Cloudflare Tunnel, but the UI and resource model must not depend on any of them.

## Status

Early development. The first vertical slice is:

**iPhone -> Pi Remote Relay -> pi-remote-host -> active Pi session -> Pi Collab -> iPhone**.
