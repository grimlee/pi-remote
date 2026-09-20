# Architecture

## Product goal

Pi Remote is a native iPhone workspace for Pi Agent.

The user-facing model is:

~~~text
trusted Host -> workspace -> session -> conversation
~~~

not:

~~~text
VPN -> hostname -> port -> terminal
~~~

The Host computer owns Pi, tools, credentials, files, and model execution. The iPhone owns presentation and user interaction.

## Components

### Pi Remote iOS

The SwiftUI app owns:

- device identity and Host grants in Keychain;
- session/workspace navigation;
- local conversation presentation cache;
- Pi RPC client state;
- native Tailcat bridge for Quick Connect;
- model/slash-command/composer UI;
- foreground/background lifecycle handling.

### pi-remote-host

The Host process owns:

- stable machine identity;
- paired-device authorization and revocation;
- Pi session discovery;
- generation-bound session linking;
- Pi RPC subprocess lifecycle;
- per-channel encryption keys;
- bounded Host->phone replay buffers;
- resume barriers and sequence reconciliation.

A persisted session is opened through Pi's native RPC mode:

~~~bash
pi --session <session-path> --mode rpc
~~~

### Pi Remote Relay

The Relay is a narrow authenticated router.

It handles:

- Host/device authentication;
- machine presence;
- signed control requests;
- session list/link responses;
- opaque encrypted Pi RPC frames.

The Relay does not need provider credentials, Host filesystem access, or plaintext Pi conversation contents.

### Tailcat underlay

Quick Connect uses Tailcat only to make the Host-local Relay reachable from the phone.

Tailcat does **not** own:

- Pi Remote machine identity;
- pairing;
- Host grants;
- device revocation;
- Pi session semantics;
- Pi RPC encryption;
- replay/resume.

That separation lets the same application semantics work over Tailcat or a public WSS Relay path.

## Preferred Quick Connect topology

~~~text
iPhone
  |
  | RelayClient
  v
PiRemoteTailcat.xcframework
  |
  | Tailcat direct path / DERP
  v
Host Tailcat sidecar
  |
  | loopback TCP
  v
local Pi Remote Relay
  |
  v
pi-remote-host
  |
  | JSONL stdin/stdout
  v
pi --session <session-path> --mode rpc
~~~

The Relay and Host normally run on the same computer for Quick Connect.

## Optional public Relay topology

~~~text
Host computer -- outbound WSS --> public Pi Remote Relay <-- WSS -- iPhone
~~~

A Cloudflare Tunnel can expose the public Relay without opening an inbound Host port.

This path remains useful as a backup or advanced self-hosted deployment, but it is no longer required for normal first-run setup.

## Identity and pairing

### Machine identity

The Host keeps a stable machine signing/key-agreement identity.

### Device identity

The iPhone keeps its own signing/key-agreement identity in Keychain.

### Pairing

A short-lived QR bootstrap authorizes a new device.

Pairing produces a Host-signed grant that binds the exact device identity to the exact Host identity. Later network reconnects reuse those identities; the user does not normally rescan a QR.

Transport reachability is not authorization. Knowing a Tailcat address or Relay endpoint is insufficient to control a Host without a valid paired-device identity and grant.

## Session discovery

The Host scans Pi's native session store, normally:

~~~text
~/.pi/agent/sessions/
~~~

Each JSONL session exposes metadata used by the iOS list:

- immutable Pi session ID;
- working directory (\`cwd\`);
- explicit session name when present;
- first-user-message fallback title;
- model metadata;
- immutable session start timestamp;
- JSONL modification time as recent activity.

The immutable Pi header timestamp is used for session generation identity. File modification time is **not** used for generation because Pi appends ordinary conversation turns to the JSONL file.

## Workspaces

Pi Remote currently derives workspaces directly from Pi session \`cwd\`.

~~~text
same cwd -> same workspace section
~~~

This is intentionally presentation-only grouping. Pi Remote does not create a second workspace database or change Pi's session format.

Workspace and session ordering use recent activity. The underlying \`cwd\` remains authoritative.

## Pi RPC channel lifecycle

When the phone opens a session:

1. iPhone sends a signed \`sessions.link(instanceId, generation)\` request.
2. Host verifies the paired device and session generation.
3. Host reuses a matching live RPC channel when possible, otherwise starts \`pi --session <path> --mode rpc\`.
4. Host creates a random per-channel key.
5. The channel capability is encrypted to the paired iPhone device identity.
6. iPhone creates a \`PiRpcClient\`.
7. Native Pi RPC commands request authoritative state/history/models/commands.
8. Pi events stream back through encrypted \`rpc.frame\` messages.

A mobile WebSocket is not the owner of the Pi subprocess. The Host is.

## Encrypted RPC framing

Pi RPC payloads are encrypted between the Host and paired iPhone.

The Relay can observe routing metadata such as:

- machine ID;
- device ID;
- channel ID;
- direction;
- sequence number.

It should not see plaintext prompts, assistant messages, tool arguments/results, or extension UI values.

## Reliable command delivery

Client commands carry monotonically increasing channel sequence numbers.

The Host acknowledges accepted client sequence numbers. The iPhone keeps a bounded in-memory journal for commands where duplicate delivery would be harmful, such as prompt submission.

On reconnect, the Host's authoritative next-client-sequence determines whether a command was already accepted or must be retried.

## Host event replay

Host->phone events also carry monotonically increasing sequence numbers.

The Host keeps a bounded replay ring for each live RPC channel. On a real transport reconnect, the iPhone can request a link using its last applied Host sequence.

If the requested sequence is still in the replay window:

~~~text
cursor -> replay missing frames -> resume ACK -> live frames continue
~~~

If the cursor is older than the retained ring, Pi Remote reconciles from authoritative Pi state rather than applying an incomplete delta history.

## Resume barriers

During session linking/resume the Host temporarily holds post-barrier live frames until the iPhone acknowledges the resume target.

This prevents new live events from overtaking replay/state synchronization.

Resume logic must preserve the existing Pi RPC subprocess whenever possible. Reconnect should repair transport, not recreate a healthy Pi task.

## Background behavior

iOS can suspend application execution and UI rendering.

Correctness therefore cannot depend on the phone continuing to process frames while backgrounded.

The intended behavior is:

~~~text
Pi keeps running on Host
        |
Host continues owning session/RPC state
        |
phone foregrounds
        |
reuse healthy transport OR reconnect/reconcile if transport was lost
~~~

A short background interval may reuse the still-healthy transport. An actual transport loss uses the replay/reconciliation path.

## Presentation cache

The iOS conversation cache exists only to improve perceived startup time.

Cached completed conversation content can render immediately, but Host/Pi state remains authoritative. Reconnection must be able to replace/reconcile cached presentation state.

## Session title semantics

Pi Remote follows Pi's native behavior:

- explicit Pi session name wins;
- otherwise the first user message is the fallback display title.

Renaming uses Pi's native \`set_session_name\` RPC command.

## Current product boundary

Pi Remote currently focuses on:

- one trusted Host;
- persisted Pi sessions;
- native conversation/session UI;
- Quick Connect over Tailcat;
- optional public Relay backup.

It intentionally does not expose a general remote shell.

It also does not currently attach to an independently running interactive Pi TUI process; Pi Remote opens the persisted session through its own native Pi RPC process.

See [roadmap.md](roadmap.md) for planned work.
