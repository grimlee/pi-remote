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

### P0 — Simple multimodal composer

The next user-facing milestone is image + text input without turning the composer into a file manager.

- Add an attachment button beside the message composer.
- Pick images from the iPhone photo library.
- Optionally capture a new image with the camera.
- Show removable image thumbnails above the composer before send.
- Send text plus images through Pi's native RPC `prompt.images` field.
- Keep reliable prompt delivery/retry semantics intact when images are present.
- Render sent user images in the transcript instead of reducing them to labels.
- Apply explicit image-count and payload-size limits before transport.
- Preserve the current text-only path when the selected model does not support image input.

General document/file upload is a separate milestone. Pi RPC has a native image input field today, while arbitrary document attachments do not have the same first-class transport contract.

### P1 — Voice dictation

- Keep the normal iOS keyboard dictation path available automatically.
- On iOS 26+, evaluate a dedicated composer microphone using Apple's on-device `SpeechAnalyzer` / `SpeechTranscriber`.
- Dictation should fill/edit the composer text; it should not create a separate audio-message format.
- Request microphone access only when the user taps the microphone.
- Do not add a server-side speech service or upload microphone audio to the Pi Host just to implement dictation.
- On older iOS versions, prefer the system keyboard's dictation unless a lightweight native fallback proves worthwhile.

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
- Render file/image outputs cleanly when Pi/tool messages expose them.

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
