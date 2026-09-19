# Pi Agent Real iPhone Test

This runbook validates the native Pi Agent backend:

~~~text
iPhone
  |
  | authenticated Relay + E2EE RPC frames
  v
Pi Remote Relay
  |
  | ciphertext routing
  v
pi-remote-host
  |
  | JSONL stdin/stdout
  v
pi --session <path> --mode rpc
~~~

The UI remains intentionally diagnostic. Success means a real iPhone can resume and control a persisted Pi session without exposing Pi RPC contents to Cloudflare or Pi Remote Relay.

## 1. Public Relay hostname

Expose the loopback Relay through your public tunnel, for example:

~~~text
relay.example.com -> http://127.0.0.1:8780
~~~

Do not place an interactive Cloudflare Access login in front of the hostname; Pi Remote performs its own cryptographic device authentication.

Verify:

~~~bash
curl -fsS https://relay.example.com/healthz
~~~

Expected:

~~~json
{"ok":true,"protocolVersion":0}
~~~

## 2. Install Relay and Host

From the Pi Remote checkout:

~~~bash
bash scripts/install-user-services.sh \
  --relay-url wss://relay.example.com/v0/host \
  --pi "$(command -v pi)"
~~~

The installer builds Host/Relay, writes owner-only environment files under `~/.config/pi-remote`, installs user systemd units, and starts them.

## 3. Preflight

~~~bash
bash scripts/preflight-real-device.sh
~~~

The preflight verifies:

- Relay service active;
- Host service active;
- local Relay health;
- configured Pi executable;
- Pi advertises RPC output mode;
- pairing IPC socket exists.

## 4. Confirm Pi sessions exist

Pi Remote discovers persisted sessions from Pi's native session store, normally:

~~~text
~/.pi/agent/sessions/
~~~

You do **not** need to enable Pi Collab.

A direct RPC smoke test that does not invoke a model is:

~~~bash
printf '%s\n' '{"id":"smoke","type":"get_state"}' | pi --mode rpc
~~~

To verify a specific historical session can be resumed:

~~~bash
printf '%s\n' '{"id":"resume","type":"get_state"}' \
  | pi --session "/path/to/session.jsonl" --mode rpc
~~~

## 5. Install the iPhone build

Download the current `PiRemote-Sideload` GitHub Actions artifact, extract the IPA, and install/re-sign it with SideStore.

The iPhone stores its stable device private keys and Host grants in Keychain.

## 6. Pair

With `pi-remote-host` running:

~~~bash
npm --prefix host run pair
~~~

Copy the one-time `piremote-pair-v1....` payload to the iPhone and pair.

Pairing remains the same trust flow: device Relay authentication, one-time HMAC proof, Host verification, Host-signed MachineGrant, and Keychain storage.

## 7. Open a Pi session

After pairing, Pi Remote should list persisted Pi sessions.

Selecting one performs:

~~~text
signed sessions.link(instanceId, generation)
  ->
Host verifies paired device
  ->
Host starts pi --session <path> --mode rpc
  ->
Host creates random 256-bit RPC channel key
  ->
channel descriptor encrypted to the exact iPhone X25519 key
  ->
Relay sees only encrypted capability
  ->
iPhone decrypts capability
~~~

Then Pi RPC commands/events travel as AES-256-GCM encrypted `rpc.frame` messages. Machine ID, device ID, channel ID, direction, and sequence number are authenticated as AAD.

## 8. Functional checks

### History and state

Opening the session automatically sends:

~~~json
{"type":"get_state"}
{"type":"get_messages"}
~~~

Confirm historical messages appear and the displayed model matches the selected Pi session.

### Prompt

Send:

~~~text
Reply with exactly: PI_REMOTE_PROMPT_OK
~~~

Confirm Pi receives it and the iPhone receives the resulting agent/message/tool events.

### Abort

Start a long turn, then tap Stop. Confirm Pi receives the native RPC `abort` command.

### Extension UI

Trigger a Pi extension `select`, `confirm`, `input`, or `editor` request. Confirm the iPhone renders it and sends the matching `extension_ui_response`.

### Background / transport resume

Start a Pi turn that takes long enough to keep producing output. While it is running, background Pi Remote or temporarily interrupt the iPhone network, then return to the app.

For a short interruption the expected path is:

~~~text
existing Pi RPC process keeps running
  ->
iPhone reconnects/authenticates to Relay
  ->
signed sessions.link(resumeFromHostSeq=last applied seq)
  ->
Host reuses the same RPC channel
  ->
missing encrypted frames replay in sequence
  ->
iPhone sends piremote.resume_ack
  ->
live delivery continues
~~~

The conversation already visible on screen should remain in memory. The app should not show a full session re-join or create another Pi RPC process.

To force a deterministic transport interruption without stopping the Host/Pi process, restart only the Relay service while a turn is running:

~~~bash
systemctl --user restart pi-remote-relay.service
~~~

Do **not** restart `pi-remote-host.service` for this test, because the live replay ring and Pi RPC subprocess intentionally live in the Host process.

After the Relay is back, reconnect from the iPhone if needed. In Host logs, a replay hit should look like:

~~~text
Pi RPC resume [rpc_...]: cursor=... target=... replay=N frame(s)
Pi RPC resume ACK [rpc_...]: target=... queued=N
~~~

Confirm:

- the same conversation remains visible;
- events that occurred during the outage appear after reconnect;
- no duplicate assistant/tool events appear;
- the current turn reaches the same final state as Pi on the Host;
- sending a new prompt still works after recovery.

### Replay-window fallback

The replay ring is intentionally bounded. If the mobile cursor is older than the retained ring, the Host reports replay unavailable and the iPhone repairs state from Pi rather than attempting partial replay.

Expected Host log:

~~~text
Pi RPC resume [rpc_...]: cursor=... target=... replay=unavailable; authoritative reconciliation required
~~~

For normal usage the default ring is 2,048 encrypted frames or 8 MiB per live RPC channel. Unit tests exercise the small-ring overflow path; production real-device testing does not need to deliberately generate thousands of events.

After fallback, confirm completed history and model/state match Pi. A partially streaming message may visually jump to authoritative state rather than replaying every missed delta; it must not create duplicated completed messages.

## 9. Diagnostics

~~~bash
systemctl --user status pi-remote-relay.service
systemctl --user status pi-remote-host.service
journalctl --user -u pi-remote-relay.service -n 100 --no-pager
journalctl --user -u pi-remote-host.service -n 100 --no-pager
curl -fsS http://127.0.0.1:8780/healthz
curl -fsS https://relay.example.com/healthz
~~~

## Current limitation

Pi RPC can resume a persisted session, but it cannot attach to an independent Pi TUI process that is already running. Do not open the same session concurrently in the TUI and Pi Remote during this milestone. A future Pi extension can provide live-process attachment.

## MVP success criterion

One real iPhone can:

- pair to the Host;
- see the real Omarchy machine;
- list persisted Pi sessions;
- open an existing session through native Pi RPC;
- receive authoritative state/history;
- send a prompt;
- receive live agent/tool events;
- abort a turn;
- answer extension UI requests;
- background and foreground without losing the live Pi RPC session;
- replay short transport gaps without duplicate or missing completed events;
- fall back to authoritative Pi state when the replay window is unavailable.

UI polish remains outside this milestone.
