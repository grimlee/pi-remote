# Pi Remote Roadmap

Pi Remote is already usable for the core workflow: start the Host, open the iPhone app, resume a Pi session, and keep working.

The roadmap is deliberately product-first. Pi Remote is **not** trying to become a terminal emulator or mobile IDE. The goal is a general-purpose remote workspace for Pi Agent.

## Current

The current integration build includes:

- Quick Connect with Tailcat.
- One-time QR pairing and automatic reconnect for existing devices.
- Optional public Relay / Cloudflare backup path.
- Native iOS session list and conversation UI.
- Workspace grouping by Pi working directory.
- Collapsible workspace sections.
- Recent-activity ordering.
- New-session creation in an existing workspace.
- Native Pi session rename.
- Streaming assistant output.
- Collapsed reasoning/tool activity.
- Slash commands.
- Model selection.
- Context usage and approximate decode-rate display.
- Copy actions for user/assistant messages.
- Abort and interactive extension UI.
- Local conversation cache.
- Background/foreground recovery.
- Encrypted Host-to-iPhone Pi RPC transport.

## Near term

### Session and workspace UX

- Search across sessions.
- Better session row hierarchy and running/waiting states.
- Optional pinned workspaces.
- Decide whether workspace collapse state should persist locally.
- Improve recent-session navigation without turning the UI into a project dashboard.
- Consider a safe session deletion design if Pi exposes an appropriate RPC or Host-side trash workflow.

### Conversation UX

- Continue visual polish around spacing, typography, tool activity, and long messages.
- Preserve reading position during long streaming turns.
- Better completion and notification UX when the app is backgrounded.
- More deliberate treatment of long-running tool/subagent work.

### Multimodal

- Image attachment/input.
- File attachment/input.
- File/image output rendering.
- Attachment lifecycle that keeps sensitive Host files under explicit user control.

### Reliability

- More background/resume testing.
- Direct-path and DERP fallback testing across more networks.
- Broader replay-window and transport-interruption tests.
- Better user-facing recovery states without exposing transport internals.

## Later

- Multiple trusted Hosts.
- Push notifications / completion alerts.
- Live Activities where useful.
- Live attachment to an independently running Pi TUI process if Pi provides a safe integration point.
- Richer subagent controls.
- Optional workspace metadata beyond raw `cwd`.
- Broader Host platform support.

## Not a goal

Pi Remote does not currently aim to become:

- a terminal emulator;
- a generic SSH client;
- a full mobile IDE;
- a remote desktop;
- a replacement for Pi Agent itself.

The iPhone should remain a lightweight session-oriented interface while Pi and its tools stay on the Host.
