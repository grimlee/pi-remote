# First Real iPhone Test

This is the first end-to-end Pi Remote validation path:

~~~text
iPhone
  |
  | authenticated Pi Remote Relay control plane
  v
Pi Remote Relay
  |
  | signed control requests
  v
pi-remote-host
  |
  | omp collab list/link
  v
Pi / OMP
  |
  | native E2EE Pi Collab data plane
  v
iPhone
~~~

The UI is intentionally diagnostic. Success means the complete control/data path works on a real iPhone.

## 1. Public Relay hostname

For the first test, it is acceptable to run Pi Remote Relay on the same Omarchy machine and expose it through the existing Cloudflare Tunnel.

Create a dedicated public hostname, for example:

~~~text
relay.example.com
~~~

Route that hostname to:

~~~text
http://127.0.0.1:8780
~~~

Pi Remote Relay itself binds loopback by default. The Tunnel is the only public ingress.

Do not put an interactive Cloudflare Access login page in front of this hostname. Pi Remote performs its own device authentication and pairing over WebSocket.

Expected public paths:

~~~text
https://relay.example.com/healthz
wss://relay.example.com/v0/host
wss://relay.example.com/v0/client
~~~

Verify the public health endpoint before pairing:

~~~bash
curl -fsS https://relay.example.com/healthz
~~~

Expected JSON:

~~~json
{"ok":true,"protocolVersion":0}
~~~

## 2. Install Relay and Host as user services

From the Pi Remote repository checkout:

~~~bash
bash scripts/install-user-services.sh   --relay-url wss://relay.example.com/v0/host   --omp "$(command -v omp)"
~~~

The installer:

- installs Node dependencies inside relay/ and host/;
- builds production dist/ output;
- writes owner-only environment files under ~/.config/pi-remote/;
- writes systemd user units;
- enables and starts pi-remote-relay.service;
- enables and starts pi-remote-host.service;
- verifies local Relay /healthz.

No sudo or system-wide Node installation is required.

Service files:

~~~text
~/.config/systemd/user/pi-remote-relay.service
~/.config/systemd/user/pi-remote-host.service
~~~

Environment files:

~~~text
~/.config/pi-remote/relay.env
~/.config/pi-remote/host.env
~~~

Logs:

~~~bash
journalctl --user -u pi-remote-relay.service -f
journalctl --user -u pi-remote-host.service -f
~~~

## 3. Run the preflight

~~~bash
bash scripts/preflight-real-device.sh
~~~

The preflight checks:

- Relay service active;
- Host service active;
- local Relay health;
- configured OMP executable;
- omp collab list --json;
- local pairing IPC socket.

If the OMP Collab registry shows zero active hosts, start/share a Pi session before continuing.

## 4. Make a Pi session remotely discoverable

The Host discovers only active Pi Collab hosts.

Check:

~~~bash
omp collab list --json
~~~

You should see at least one entry in hosts[].

If none exists, start Pi/OMP and enable Collab for the session, or use the upstream collab.autoStart configuration if desired.

The session generation shown here is what protects Pi Remote from connecting to a stale/replaced room.

## 5. Install the current iPhone build

On GitHub Actions for main, download the latest:

~~~text
PiRemote-Sideload
~~~

artifact and extract PiRemote-Sideload.ipa.

Install/re-sign it using SideStore.

The app stores its device signing/X25519 private keys and Host authorization grants in iOS Keychain.

## 6. Create the one-time pairing payload

The Host service must already be running.

From the repository:

~~~bash
npm --prefix host run pair
~~~

It prints a payload beginning with:

~~~text
piremote-pair-v1.
~~~

The payload is short-lived and one-time.

It contains:

- public Relay client URL;
- Host public identity;
- one-time pairing ID;
- one-time random secret.

The one-time secret is not sent to Pi Remote Relay. The iPhone proves possession using HMAC and its device key.

## 7. Pair the iPhone

Open Pi Remote.

1. Tap Paste from Clipboard.
2. Paste the one-time payload.
3. Tap Pair this iPhone.

Expected sequence:

~~~text
iPhone authenticates device key to Relay
  ->
pairing.request routed to exact Host signing key
  ->
Host validates one-time HMAC + device signature
  ->
Host authorizes device locally
  ->
Host signs MachineGrant
  ->
iPhone verifies Host signature + MachineGrant
  ->
grant/profile stored in Keychain
  ->
Host becomes visible
~~~

If a test configuration becomes unusable, use the top-right menu -> Forget Host. This clears only the current Host profile and MachineGrant; the iPhone device identity remains stable.

## 8. Open a real Pi session

After pairing, the app should show the real sessions returned by:

~~~bash
omp collab list --json
~~~

Tap one.

Expected control-plane path:

~~~text
sessions.link(instanceId, generation)
  ->
Host calls omp collab link
  ->
Host encrypts Collab capability to this iPhone X25519 key
  ->
Relay sees ciphertext only
  ->
iPhone decrypts capability
~~~

Then the app switches to the native Pi Collab data plane.

Expected data-plane path:

~~~text
CollabGuestClient
  ->
hello proto v3
  ->
welcome
  ->
snapshot-chunk...
  ->
live
~~~

The diagnostic session screen should display the existing transcript as raw JSON cards.

## 9. First functional checks

Run these in order.

### Existing transcript

Confirm historical session entries appear after the authoritative snapshot finishes.

### Prompt

From iPhone, send:

~~~text
Reply with exactly: PI_REMOTE_PROMPT_OK
~~~

Confirm the host Pi receives it and the iPhone receives the resulting live state/events.

### Abort

Start a request that runs long enough to interrupt, then tap Stop.

Confirm the host Pi aborts the active turn.

### Interactive request

Trigger a Pi select/editor request if available.

Confirm the iPhone renders the request and the response reaches the Host.

### Background reconciliation

While the Pi session is still active:

1. background Pi Remote;
2. let Pi continue doing work on the computer;
3. foreground Pi Remote.

Expected behavior:

~~~text
old mobile sockets discarded
  ->
Relay reconnect/authenticate
  ->
sessions refresh
  ->
fresh generation-bound link
  ->
fresh Collab welcome/snapshot
  ->
mobile state replaced by Host-authoritative state
~~~

No Pi process should restart.

## 10. Useful diagnostics

Control plane:

~~~bash
systemctl --user status pi-remote-relay.service
systemctl --user status pi-remote-host.service
journalctl --user -u pi-remote-relay.service -n 100 --no-pager
journalctl --user -u pi-remote-host.service -n 100 --no-pager
~~~

Pi registry:

~~~bash
omp collab list --json
~~~

New pairing payload:

~~~bash
npm --prefix host run pair
~~~

Local Relay:

~~~bash
curl -fsS http://127.0.0.1:8780/healthz
~~~

Public Relay:

~~~bash
curl -fsS https://relay.example.com/healthz
~~~

## MVP success criterion

The first real-device milestone is considered technically closed when one real iPhone can:

- pair to the Host;
- see the real Omarchy machine;
- list a real Pi session;
- enter that session through native Pi Collab;
- receive the authoritative transcript;
- send a prompt;
- receive live activity;
- abort a turn;
- answer an interactive request;
- background and foreground without stopping Pi.

UI polish is explicitly outside this milestone.
