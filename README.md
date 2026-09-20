# Pi Remote

**Pi Remote is a native iPhone client for [Pi Agent](https://pi.dev).**

It lets Pi keep running on your computer while your iPhone becomes a lightweight, secure workspace for continuing sessions, sending prompts, watching live responses, using Pi tools, changing models, and handling interactive requests.

Pi Remote is intentionally **not a terminal emulator and not a coding-only remote**. The UI is session-first: open a workspace, pick up a conversation, and keep working.

> **Status:** early, usable, and actively developed. The current build is being tested daily on a real iPhone and Linux host. Expect rough edges, but the main remote workflow is working.

## Why Pi Remote?

Pi is most useful when it can stay on the machine that already has your files, tools, credentials, browser state, MCP servers, and local models. Pi Remote keeps that execution model intact:

- Pi and all tools stay on the Host computer.
- Provider credentials never need to move to the phone.
- The iPhone shows a native conversation UI instead of a remote shell.
- Persisted Pi sessions can be resumed from anywhere.
- Quick Connect avoids public ports, domains, Cloudflare setup, and a system VPN profile.

The original prototype used a public Relay behind Cloudflare Tunnel. That path still exists as an optional backup, but the preferred setup is now **Quick Connect**, powered by [Tailcat](https://github.com/tailscale/tailcat).

## Current features

### Session-first iOS experience

- Native SwiftUI iPhone app.
- Persisted Pi sessions grouped by their working folder/workspace.
- Collapsible workspace sections.
- Sessions and workspaces ordered by recent activity.
- Create a new session in an existing workspace.
- Rename a session using Pi's native `set_session_name` RPC command.
- Local conversation cache for fast reopening.
- Streaming assistant output.
- Reasoning/tool activity grouped and collapsible.
- Slash command discovery and execution.
- Model picker.
- Context usage and approximate live decode-rate display.
- Long-press copy for user and assistant messages.
- Abort/stop support.
- Pi extension UI requests such as confirm/input/select/editor.

### Quick Connect

- One-command Host launcher.
- One-time QR pairing.
- Existing pairings reconnect after Host/app restarts without rescanning.
- Tailcat runs as Pi Remote's transport underlay.
- No public IP or inbound port required.
- No Cloudflare domain required.
- No Tailscale system VPN profile required on the iPhone.
- Existing public Relay / Cloudflare deployments can remain as a backup path.

### Reliability and security

- Stable machine and device identities.
- Host-authoritative device grants and revocation.
- Per-request device signatures.
- Pi RPC traffic encrypted end-to-end between Host and iPhone.
- Relay sees routing metadata, not prompt/transcript/tool contents.
- Live Pi RPC process is owned by the Host rather than the mobile socket.
- Sequence tracking, bounded replay, and authoritative-state reconciliation for transport recovery.
- Provider/API credentials remain on the Host.

## Quick start

### Requirements

Host:

- Pi Agent installed and available as `pi`.
- Node.js 22 or newer.
- npm.
- Linux x86_64 or arm64 for the automatic Tailcat download path.

The project is currently tested primarily on Linux (including Omarchy). Other Host platforms are not yet part of the regular test matrix.

iPhone:

- iOS 17 or newer.
- A way to sideload an IPA, such as SideStore, AltStore, or your preferred signing workflow.

A paid Apple Developer account is **not required to experiment with Pi Remote**, but free-account sideloading typically requires periodic re-signing/refreshing. There is currently no App Store or TestFlight release.

### 1. Clone Pi Remote

~~~bash
git clone https://github.com/grimlee/pi-remote.git
cd pi-remote
~~~

### 2. Start Quick Connect

~~~bash
npm start
~~~

On first run the launcher:

1. installs the Host/Relay Node dependencies;
2. downloads and SHA-256 verifies the pinned Tailcat binary when needed;
3. creates a persistent Tailcat transport key;
4. starts the local Pi Remote Relay and Host;
5. shows a short-lived pairing QR.

The automatic Tailcat download currently supports Linux x86_64 and arm64.

Runtime logs are written under:

~~~text
.runtime/
~~~

Sensitive runtime state is gitignored.

### 3. Install the iPhone app

Open the repository's **Actions** tab, choose the latest successful **iOS Build**, and download the `PiRemote-Sideload` artifact.

Extract the artifact if necessary and install/re-sign the IPA using your sideloading tool.

The GitHub Actions build produces an unsigned device IPA; it is not an App Store-signed release.

### 4. Pair once

Open Pi Remote on the iPhone and scan the QR shown by `npm start`.

After a device is paired, later Host restarts normally hide the QR automatically:

~~~text
Host:   npm start
Phone:  open Pi Remote
Result: reconnect
~~~

In the launcher:

~~~text
p   show a fresh pairing QR / pair another device
s   show the compatibility text QR
q   stop Pi Remote
~~~

### 5. Use Pi Remote

Pi Remote discovers persisted sessions from Pi's native session store, normally under:

~~~text
~/.pi/agent/sessions/
~~~

Sessions are grouped by their Pi working directory. Open a session to continue it, or use the new-session button to start another session in one of the existing workspaces.

Pi Remote starts/resumes a native Pi RPC backend using the persisted session:

~~~bash
pi --session <session-path> --mode rpc
~~~

You do **not** need to keep a Pi TUI window open for Pi Remote.

## What Quick Connect actually does

Quick Connect changes reachability, not Pi Remote's trust model.

~~~text
iPhone
  |
  | RelayClient
  v
native Tailcat bridge
  |
  | Tailcat direct path / DERP fallback
  v
Host Tailcat sidecar
  |
  v
local Pi Remote Relay
  |
  v
pi-remote-host
  |
  | encrypted Pi RPC channel
  v
pi --session ... --mode rpc
~~~

Machine identity, pairing, authorization, session discovery, Pi RPC encryption, replay/resume, and device revocation remain Pi Remote responsibilities. Tailcat is only the network underlay.

See [docs/tailcat-transport.md](docs/tailcat-transport.md) for the transport design.

## Public Relay / Cloudflare backup

The older public Relay path is still supported for advanced/self-hosted setups. It is no longer required for the normal Quick Connect flow.

If you want that deployment model, see [docs/real-device-test.md](docs/real-device-test.md) and [docs/security.md](docs/security.md).

## Session behavior

Pi Remote reads the native Pi JSONL session store.

A session title follows Pi's own semantics:

- an explicit Pi session name is preferred;
- otherwise the first user message becomes the fallback title.

Pi Remote can rename the current session through Pi RPC. Session deletion is intentionally not exposed yet because Pi RPC currently does not provide a delete-session command; destructive Host-side file management deserves a separate design.

The session list uses JSONL modification time as its recent-activity signal while keeping Pi's immutable session timestamp as the generation identity.

## Background behavior

The Host owns the Pi RPC process, so iOS suspension should not stop the model/tool work running on the computer.

When the app remains briefly reachable, foregrounding can reuse the existing transport. When a transport is actually lost, Pi Remote has sequence/replay and authoritative reconciliation paths for recovery.

The iPhone is not expected to continuously render streaming UI while iOS has suspended the app.

## Architecture

~~~text
                   Quick Connect (preferred)

iPhone
  |
  | native Tailcat transport
  v
Host computer
+------------------------------------------------------+
| local Relay <----> pi-remote-host                    |
|                       |                              |
|                       | JSONL stdin/stdout           |
|                       v                              |
|              pi --session ... --mode rpc             |
+------------------------------------------------------+

             optional public Relay / CF fallback
~~~

The Relay routes authenticated control traffic and opaque encrypted RPC frames. It does not need provider credentials or Host filesystem access.

More detail: [docs/architecture.md](docs/architecture.md).

## Repository layout

~~~text
.github/             CI and unsigned IPA packaging
docs/                Architecture, security, transport, testing, roadmap
host/                Host identity, session registry, Pi RPC bridge
ios/                 Native SwiftUI app
ios/PiRemoteCore/    Shared protocol and cryptographic core
native/tailcat-ios/  Native Tailcat iOS bridge
protocol/            Control-plane and pairing protocol notes
relay/               Authenticated routing service
scripts/             Quick Connect launcher and diagnostics
~~~

## Development

Host/Relay tests:

~~~bash
npm --prefix host test
npm --prefix relay test
~~~

Type checking/build:

~~~bash
npm --prefix host run typecheck
npm --prefix relay run typecheck
npm --prefix host run build
npm --prefix relay run build
~~~

PiRemoteCore:

~~~bash
cd ios/PiRemoteCore
swift test
~~~

The iOS GitHub Actions workflow builds the Tailcat XCFramework, tests PiRemoteCore, generates the Xcode project, builds simulator/device targets, and packages an unsigned sideload IPA.

## Known limitations

- No App Store/TestFlight distribution yet; sideloading is required.
- The UI is still evolving.
- Text is the main input path today; richer image/file input is still planned.
- One trusted Host is the primary product flow today.
- Pi Remote resumes persisted Pi sessions through a separate Pi RPC process; it does not attach to an independently running interactive Pi TUI process.
- Session deletion is not exposed yet.
- Quick Connect has been tested most heavily on Linux Host + real iPhone.
- Public Relay / Cloudflare remains an advanced backup path rather than the recommended first-run setup.

## Roadmap

See [docs/roadmap.md](docs/roadmap.md).

The near-term focus is product quality rather than turning Pi Remote into a terminal or IDE:

- better session/workspace navigation and search;
- richer file/image input and output;
- notification/background-completion UX;
- additional Host/platform testing;
- multi-host support;
- continued reliability and UI polish.

## Feedback and contributions

Pi Remote started as a personal remote workflow and has grown into a usable open-source project. Feedback from Pi users is especially valuable because there are many workflows the current design has not seen yet.

If you try it, useful reports include:

- your Host OS and iOS version;
- whether Quick Connect paired/reconnected successfully;
- what kind of Pi workflow you use it for;
- UI/UX friction;
- session/reconnect edge cases;
- ideas that would make Pi Remote useful outside coding.

Please avoid posting pairing payloads, Tailcat addresses/private keys, private session JSONL files, or logs containing sensitive local data.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution notes.

## Security

Please read [docs/security.md](docs/security.md) before exposing a Relay publicly or changing the pairing/transport model.

Provider keys, browser cookies, SSH credentials, MCP credentials, and Host environment secrets should remain on the Host.

## License

Pi Remote is released under the [MIT License](LICENSE).

---

Pi Remote is an independent community project built around Pi Agent and Tailcat. It is not an official Pi Agent, Tailcat, Tailscale, or Apple product.
