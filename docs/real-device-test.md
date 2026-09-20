# Real iPhone test guide

This guide validates the current Pi Remote workflow on a real iPhone.

The preferred path is Quick Connect:

~~~text
iPhone
  |
  | Tailcat underlay
  v
Host-local Relay
  |
  | encrypted Pi RPC frames
  v
pi-remote-host
  |
  | JSONL stdin/stdout
  v
pi --session <path> --mode rpc
~~~

The older public Relay / Cloudflare path remains available as an advanced backup.

## 1. Host prerequisites

Verify:

~~~bash
node --version
npm --version
command -v pi
pi --version
~~~

Node.js 22 or newer is required by the Host/Relay packages.

Pi Remote currently expects persisted Pi sessions under Pi's normal session store, usually:

~~~text
~/.pi/agent/sessions/
~~~

A model-free RPC smoke test:

~~~bash
printf '%s\n' '{"id":"smoke","type":"get_state"}' | pi --mode rpc
~~~

## 2. Start Quick Connect

From the repository root:

~~~bash
npm start
~~~

Expected first-run behavior:

- Host/Relay dependencies are installed if missing;
- pinned Tailcat is found or downloaded/verified;
- a persistent Tailcat key is created;
- local Relay starts;
- Host starts;
- pairing QR appears if no active paired device exists.

Logs:

~~~text
.runtime/relay-trace.log
.runtime/host-trace.log
~~~

Launcher keys:

~~~text
p   new pairing QR
s   compatibility QR
q   stop
~~~

After the iPhone has already been paired, a normal restart should hide the QR and show that the existing pairing was found.

## 3. Install the iPhone build

Open GitHub Actions and download the latest successful \`PiRemote-Sideload\` artifact from the **iOS Build** workflow.

Install/re-sign the IPA using SideStore, AltStore, or another sideloading workflow.

The artifact is an unsigned sideload IPA, not an App Store-signed build.

## 4. Pair

On first use:

1. Open Pi Remote.
2. Tap the Quick Connect pairing action.
3. Scan the QR shown by the Host launcher.
4. Wait for the Host/session list to appear.

Normal later restarts should reconnect with the stored device identity and MachineGrant without another scan.

## 5. Session list checks

Confirm:

- persisted Pi sessions appear;
- sessions are grouped by Pi working directory/workspace;
- workspace sections can collapse/expand;
- recent activity affects ordering;
- session title is the explicit Pi name when present, otherwise first-user-message fallback;
- new-session action offers existing workspaces.

## 6. Open a session

Opening a session performs a signed generation-bound session link.

The Host either reuses an appropriate live RPC channel or starts:

~~~bash
pi --session <session-path> --mode rpc
~~~

The phone then requests authoritative Pi state/history.

Confirm:

- historical messages appear;
- model state appears;
- conversation scroll/keyboard behavior remains stable;
- returning to a previously opened session is fast.

## 7. Prompt and streaming

Send:

~~~text
Reply with exactly: PI_REMOTE_PROMPT_OK
~~~

Confirm:

- submitted user message appears once;
- assistant response streams;
- completed response remains visible;
- no transcript blanking/jumping occurs when showing/hiding the keyboard.

For a longer stream, verify manual scrolling remains responsive.

## 8. Model / context / speed

Open the model selector and switch models if the session supports it.

Confirm:

- selected model updates;
- context usage is visible when Pi reports it;
- approximate decode-rate display appears while streaming;
- changing these controls does not destabilize conversation scrolling.

The speed value is a UI/runtime estimate based on observed Pi delta events, not a tokenizer-verified exact tokens-per-second benchmark.

## 9. Copy and rename

Long-press a user or assistant message and confirm Copy works.

Use the session action menu to rename the session.

Confirm the renamed title persists after leaving/reopening the session because Pi Remote calls Pi's native \`set_session_name\` RPC command.

## 10. Slash commands and extension UI

Verify slash command discovery/selection.

If available in your Pi setup, trigger extension UI:

- select;
- confirm;
- input;
- editor.

Confirm Pi Remote renders the request and sends the matching response.

## 11. Abort

Start a long turn and tap Stop.

Confirm the turn aborts and the UI returns to a writable state.

## 12. Background/foreground

Start a sufficiently long generation, then background Pi Remote for 10-30 seconds.

Expected behavior:

- the Host-owned Pi task continues;
- the iPhone does not need to keep rendering in the background;
- returning to the app should not recreate a healthy Pi RPC task;
- the conversation should continue/reconcile without duplicate content;
- \`Pi running\` should not remain stuck after the task has actually finished.

A short background interval may reuse the existing transport directly.

## 13. Deterministic transport interruption

To test actual replay/resume, interrupt transport rather than merely backgrounding the iPhone.

For the public Relay/systemd deployment, restart only the Relay while a turn is running:

~~~bash
systemctl --user restart pi-remote-relay.service
~~~

Do not restart the Host for this test because the live Pi RPC subprocess and replay ring are intentionally Host-owned.

Expected Host logs for a replay hit:

~~~text
Pi RPC resume [rpc_...]: cursor=... target=... replay=N frame(s)
Pi RPC resume ACK [rpc_...]: target=... queued=N
~~~

Confirm:

- same conversation remains visible;
- missed events are reconciled/replayed;
- no duplicate assistant/tool output appears;
- the turn reaches the same final state as Pi on the Host;
- a new prompt still works afterward.

## 14. Replay-window fallback

The Host replay ring is bounded.

Current defaults are approximately:

- 2,048 encrypted Host frames;
- 8 MiB per live RPC channel.

If the mobile cursor is older than the retained ring, the Host reports replay unavailable and the iPhone repairs authoritative state from Pi.

Expected Host log:

~~~text
Pi RPC resume [rpc_...]: cursor=... target=... replay=unavailable; authoritative reconciliation required
~~~

The fallback must not create duplicate completed messages.

## 15. Network changes

Useful real-device checks:

- Wi-Fi to cellular;
- cellular to Wi-Fi;
- proxy/VPN on/off;
- Host launcher stop/start;
- iOS app stop/start.

An already paired device should normally reconnect without scanning another QR unless transport coordinates/identity were deliberately rotated.

## 16. Public Relay / Cloudflare backup

Quick Connect is preferred, but the older public topology remains supported.

Install the systemd services:

~~~bash
bash scripts/install-user-services.sh \
  --relay-url wss://relay.example.com/v0/host \
  --pi "$(command -v pi)"
~~~

Expose the local Relay origin through your tunnel and verify:

~~~bash
curl -fsS https://relay.example.com/healthz
~~~

Do not put an interactive browser login page in front of the Relay WebSocket.

## 17. Diagnostics

Quick Connect:

~~~bash
tail -n 100 .runtime/host-trace.log
tail -n 100 .runtime/relay-trace.log
~~~

Public/systemd path:

~~~bash
systemctl --user status pi-remote-relay.service
systemctl --user status pi-remote-host.service
journalctl --user -u pi-remote-relay.service -n 100 --no-pager
journalctl --user -u pi-remote-host.service -n 100 --no-pager
~~~

Review logs before sharing them publicly.

## Current limitations

- Sideloading is required; there is no App Store/TestFlight release.
- Rich image/file input is still planned.
- Session deletion is not exposed.
- Pi Remote opens persisted sessions through its own Pi RPC process rather than attaching to an independently running Pi TUI.
- Quick Connect is tested most heavily on Linux Host + real iPhone.

## Success criterion

A successful real-device build should let one paired iPhone:

- discover its trusted Host;
- browse workspace-grouped Pi sessions;
- open existing history;
- create a new session in an existing workspace;
- rename sessions;
- send prompts;
- receive live assistant/tool events;
- switch supported models;
- use slash commands;
- copy messages;
- abort turns;
- handle interactive extension UI;
- background/foreground without stopping Host work;
- recover from real transport interruptions without duplicated completed output.
