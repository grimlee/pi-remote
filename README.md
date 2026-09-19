# Pi Remote

Native iOS remote control for **Pi Agent** running on your computer.

The goal is a ChatGPT Remote-style experience: Pi and its tools stay on the host computer while the iPhone acts as a secure control surface for discovering persisted sessions, resuming work, observing events, steering, interrupting, and answering interactive requests.

## Product principles

- **Native iOS UX** — SwiftUI, native navigation, keyboard handling, notifications, and background recovery.
- **Host executes everything** — LLM calls, shell commands, filesystem access, MCP tools, browser tools, and subagents remain on the computer.
- **Machine identity, not IP addresses** — users interact with trusted machines and sessions, not hostnames, VPNs, ports, or tunnel URLs.
- **Outbound-only host connectivity** — the host initiates the Relay connection; no inbound host port is required.
- **Native Pi RPC backend** — remote sessions run through `pi --session <path> --mode rpc`.
- **End-to-end encrypted agent traffic** — prompt, transcript, tool, state, and extension-UI payloads are encrypted between the paired iPhone and Host. Relay routes opaque frames.
- **Host-authoritative state** — mobile disconnects are routine; a live Pi RPC process survives transport loss, short gaps replay by sequence, and longer gaps reconcile from authoritative Pi state.
- **Local cache is an accelerator, not authority** — cached completed messages render instantly on cold open, then Host/Pi state reconciles them.
- **Provider credentials stay on Host** — Antigravity and other provider credentials are never moved to the phone or Relay.

## Architecture

~~~text
                     authenticated control plane
Host computer ── outbound WSS ─► Pi Remote Relay ◄─ WSS ─ iPhone
┌──────────────────────┐         ┌───────────────┐          ┌─────────────┐
│ pi-remote-host       │         │ machine       │          │ Pi Remote   │
│ machine identity     │         │ presence      │          │ SwiftUI     │
│ pairing / grants     │         │ routing only  │          │             │
│ Pi session registry  │         │               │          │             │
└──────────┬───────────┘         └───────┬───────┘          └──────┬──────┘
           │                             │                         │
           │ JSONL stdin/stdout          │ opaque ciphertext       │
           ▼                             │                         │
 pi --session ... --mode rpc             └──── E2EE RPC frames ───┘
~~~

The Relay can see routing metadata such as machine/device/channel identifiers, but not Pi prompts, assistant messages, tool arguments/results, or transcript contents.

## Session model

Pi Remote lists persisted Pi session files from the Host's native Pi session store. Selecting one opens a dedicated RPC process:

~~~bash
pi --session <session-path> --mode rpc
~~~

The iPhone then requests authoritative state and history with Pi's native RPC commands and receives live Pi events. A live RPC channel is independent from the mobile WebSocket lifetime: the Host keeps a bounded encrypted replay ring, so reconnecting clients can resume from their last applied Host sequence without spawning another Pi process.

Current limitation: the RPC backend resumes persisted sessions; it does not attach to an already-running interactive Pi TUI process. Live attachment can be added later with a Pi extension.

## MVP

1. Register one Host with a stable machine identity.
2. Keep an outbound Host connection to Pi Remote Relay.
3. Pair one iPhone using its stable Ed25519/X25519 identity.
4. Show trusted Host presence.
5. List persisted Pi sessions.
6. Open a generation-bound Pi RPC channel.
7. Deliver the per-channel key only to the paired iPhone through the existing X25519/HKDF capability envelope.
8. Load Pi state and message history.
9. Stream agent/tool/extension events.
10. Send prompt / abort / extension UI responses.
11. Reconnect after backgrounding without recreating a healthy Pi RPC process.
12. Replay short encrypted event gaps by sequence and fall back to authoritative Pi reconciliation when the replay window is unavailable.

Later phases add new-session creation, workspace/model controls, file and diff viewers, push notifications, Live Activities, multiple hosts, richer subagent controls, and live attachment to an existing Pi TUI process.

## Repository layout

~~~text
docs/       Architecture, security decisions, and real-device runbooks
host/       Host-side control agent and Pi RPC process bridge
ios/        Native SwiftUI application and shared cryptographic core
protocol/   Pi Remote control-plane protocol notes
relay/      Minimal authenticated router for control and opaque E2EE RPC frames
~~~

## Connectivity policy

Pi Remote treats network transport as an underlay. Machine identity, pairing, authorization, Pi RPC, replay/resume, and E2EE semantics stay the same regardless of how the phone reaches the Relay.

The preferred user path is **Quick Connect**, backed by Tailcat:

~~~text
first use:  start Pi Remote -> scan one QR -> paired
later use:  start Pi Remote -> open iPhone app -> connected
~~~

Tailcat runs inside Pi Remote rather than taking ownership of the iPhone's system VPN slot. The normal path therefore does not require a public IP, domain, Cloudflare setup, or a Tailscale VPN profile.

The existing public Relay / Cloudflare Tunnel path remains the backup connection. When a host is migrated from an existing Relay pairing to Quick Connect, Pi Remote preserves the existing WSS Relay endpoint so it can be offered as a backup instead of being discarded.

Tailcat is only the transport underlay. It does not become a second Pi Remote protocol.

## Status

The current vertical slice is:

**iPhone -> authenticated Relay -> pi-remote-host -> native Pi RPC session**, with Pi RPC contents encrypted end-to-end between iPhone and Host.
