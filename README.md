# Pi Remote

Native iOS remote control for a Pi / Oh My Pi agent running on your computer.

The goal is a ChatGPT Remote-style experience: the agent and tools keep running on the host computer while the iPhone acts as a secure, low-latency remote client for starting, observing, steering, interrupting, and answering interactive requests.

## Product principles

- **Native iOS UX** — SwiftUI, native navigation, keyboard handling, haptics, notifications, and background recovery.
- **Host executes everything** — LLM calls, shell commands, filesystem access, MCP tools, browser tools, and subagents remain on the computer.
- **No exposed Pi TCP API** — reuse Pi Collab's encrypted session transport and local host registry instead of opening the agent directly to the Internet.
- **Resume cleanly** — iOS may suspend the app; reconnecting must restore authoritative host state without restarting the agent.
- **Protocol-first** — UI, host control plane, and Pi Collab transport stay separated so each can evolve independently.

## Target architecture

```text
                 iPhone
          +------------------+
          | Pi Remote        |
          | SwiftUI          |
          +--------+---------+
                   |
          encrypted WebSocket
                   |
            +------v------+
            | Collab Relay |
            | ciphertext   |
            +------+-------+
                   |
          encrypted WebSocket
                   |
        +----------v-----------+
        | Host computer        |
        |                      |
        | pi-remote-host       |
        |   |                  |
        |   +-- discovery      |
        |   +-- start/resume   |
        |   +-- pairing        |
        |                      |
        | Pi / OMP Agent       |
        |   +-- LLM            |
        |   +-- shell/files    |
        |   +-- MCP/browser    |
        |   +-- subagents      |
        +----------------------+
```

## MVP

1. Pair one iPhone with one host computer.
2. Show whether the host is reachable.
3. List active Pi Collab sessions.
4. Open a session and render its current transcript.
5. Stream assistant text and tool activity live.
6. Send a prompt.
7. Interrupt a running turn.
8. Answer host interactive requests.
9. Reconnect after backgrounding and recover current state.

Later phases add new-session creation, workspace/model controls, file and diff viewers, push notifications, Live Activities, multiple hosts, and richer subagent controls.

## Repository layout

```text
docs/       Architecture, protocol, and security decisions
host/       Small host-side control plane (not the agent runtime)
ios/        Native SwiftUI application
protocol/   Pi Remote control-plane message definitions
```

## Relationship to Pi Collab

Pi Remote does not replace Pi Collab. Pi Collab is the session data plane: transcript replication, prompt/interrupt control, interactive requests, subagent state, WebSocket transport, and end-to-end encryption.

`pi-remote-host` supplies the missing device-level control plane: pairing, host presence, session discovery, and eventually starting/resuming sessions. The iOS app uses the control plane to discover a session and then connects to the session through the Collab transport.

## Status

Early development. The first milestone is an end-to-end vertical slice from an iPhone client to a Pi session running on a host computer.
