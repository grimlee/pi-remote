# Authenticated browser Tailcat experiment

Implements Issue #42 Phase 1 as a separate, reviewable transport. The owner has
reported repeated iPhone Echo successes; this permits isolated development.
The authenticated client still requires actual iPhone acceptance, including
its Worker, WebCrypto, IndexedDB and background/network lifecycle.

No production service is installed or restarted by building this directory.
Keep the original Tailscale PWA, native Tailcat, T3, SSH and Serve routes as the
fallback. Do not publish an Agent HTTP API or proxy one through the static site.
Review authentication before starting a real-Agent test deployment.

## Transport and trust

* Public HTTPS serves program assets only. `static.mjs` verifies their manifest
  hashes and has an exact filename allowlist. It rejects queries, POSTs, key
  files and `/api` routes. It does not log URLs or forward requests to an Agent.
* A module Worker runs the official Go 1.27.1 / Tailcat v0.6.0 build at commit
  `790406204c002a6f109ef7c6a30a436601a1f6a8`. Browser TCP bytes travel over
  Tailcat's encrypted DERP/WebSocket tunnel. No WebRTC fork is used.
* The loopback gateway accepts a versioned framed protocol, not HTTP or arbitrary
  Pi RPC. It shares `PiService`, `PiRunner` and the durable `CommandLedger` with
  the existing private HTTPS adapter. Native transport code/keys stay unchanged.
* Device authentication uses P-256 ECDSA/SHA-256. This avoids assuming optional
  Ed25519/X25519 WebCrypto support on iOS; Tailcat's own WireGuard crypto is
  unchanged. The browser tests sign/verify and structured-cloning of **nonextractable**
  private keys. Actual iPhone support is a remaining acceptance gate.
* The Host has a separate signing identity and owner grants in an isolated
  browser state directory. A locally obtained one-time bundle pins the Host
  key, Tailcat address, HTTPS origin, expiry and a 256-bit secret. Its signed
  contents are pasted in-page or scanned as plain text; never use a URL query,
  fragment, public QR, issue attachment or analytics event for pairing.
* Pairing verifies device proof of key possession before consuming the invite.
  A grant and the spent invite are persisted together by an atomic, fsynced
  file replacement. Only the invite hash is stored. Invitations expire after
  five minutes by default and cannot be reused by another device.
* Every connection gets a signed random Host challenge. Device authentication
  and each request bind its signature to that challenge, connection, Host,
  device, sequence, request ID, operation and arguments. Captured requests or
  authentication proofs do not work on another connection. Tailcat possession
  alone never authorizes an Agent request.
* Grants are checked again on requests and response/event sends. Local admin
  revocation immediately closes that device's sockets. It prevents new control;
  it cannot undo a tool/command already accepted by Pi.
* IndexedDB stores the nonextractable signing and wrapping CryptoKeys. Host
  configuration (including the sensitive Tailcat capability and pending command
  IDs) is AES-GCM sealed with the nonextractable wrapping key. No bearer token or
  plaintext Agent credentials go in localStorage. Static-origin JavaScript must
  remain trusted: nonextractability does not prevent same-origin malicious code
  from using a key. Do not claim this design has had an independent security audit.

## Recovery and limits

The Worker maintains one authenticated tunnel for multiplexed requests and
subscriptions. It closes the tunnel on backgrounding, reconnects on foreground,
online events and connection failure with 1–15 second backoff plus jitter, and
the UI rebuilds subscriptions from authoritative snapshots and command receipts.
15-second signed heartbeats refresh a 45-second Host lease. Pi runners survive
browser disconnection; a gateway/process crash is not durable tool execution.

All mutations reserve an fsynced receipt before dispatch. Their IDs survive in
sealed browser state; after reconnect only receipt reads are retried. Missing or
`unknown` receipts are retained for operator inspection and never automatically
reissued. Oversized requests fail before reservation; authoritatively rejected
validation requests clear their pending IDs. Prompt IDs also retain the existing UI recovery semantics. Unconfirmed
operations deliberately block further mutations, except explicit abort. Inspect
the Host's receipt and session before resolving ambiguous state; do not clear
browser state and blindly resend. Cancellation drops a pending response; it is
not an implicit Pi abort and cannot roll back a dispatched mutation.

Budgets are explicit: 32 sockets, eight in-flight requests/socket, four streams,
128 KiB incoming frames, 24 KiB response chunks, 8 MiB aggregate assembling or
sending results, 2 MiB queued socket writes, and eight/1 MiB unacknowledged UI
events. Slow/suspended clients disconnect rather than accumulate output.
RPC stdout has a 16 MiB record budget. A connection rotates after 4096 requests.
Session listing pages contain at most 100 entries (10,000 scanned maximum);
state pages contain at most 160 messages and a cursor guards history changes.
Large individual results fail explicitly rather than silently truncate.
An old event cursor returns a reset and the client resynchronizes authoritative
state. The existing transcript UI renders its latest 160-message window;
historical pages are available through the transport API.

The client maps pairing/login, list/create/rename, models, prompt, abort, state,
receipts and subscriptions. New empty sessions are seeded with Pi's documented
v3 header/name metadata because current Pi delays persisting new empty sessions
until an assistant turn. Execution stays entirely in the existing RPC runner.
Only Host-configured or already discovered workspaces may be used for creation.

## Build static artifacts

The GitHub Actions workflow builds the pinned upstream WASM and packages both the
Echo PoC and `pi-remote-tailcat-secure-static`. It does **not** publish Pages or
configure a public Agent route. The Go runtime and WASM must come from the same
build. Locally, point the builder at the verified Actions artifact directory:

```sh
node pwa/tailcat/build.mjs /absolute/pinned-wasm-artifact dist/tailcat-secure
node pwa/tailcat/static.mjs dist/tailcat-secure 17989
```

The input must contain `main.wasm.gz`, `wasm_exec.js`, and `TAILCAT-LICENSE`.
The static service listens only on `127.0.0.1`. Use an independently approved
HTTPS static origin; enabling public GitHub Pages needs owner confirmation.
The generated worker caches only enumerated static assets, including WASM, in
a distinct content-versioned cache. It never caches API responses or pairing
data. The legacy PWA shell cache is bumped to v7.3 for its optional adapter hook;
the live installation is not changed by this branch.

## Explicit isolated test deployment (after review)

Use a separate checkout, new state directory and new Pi session directory. Check
that 17987 and 17989 are free. Never point these examples at active native/PWA
session directories or reuse native Tailcat private keys.

```sh
PI_REMOTE_BROWSER_STATE_DIR=/absolute/private/browser-test/state \
PI_REMOTE_BROWSER_SESSION_DIR=/absolute/private/browser-test/sessions \
PI_REMOTE_BROWSER_WORKSPACES='["/absolute/disposable/workspace"]' \
PI_REMOTE_BROWSER_PI_COMMAND=/absolute/path/to/pi \
node pwa/tailcat/gateway.mjs
```

In another isolated process, expose **only** the new gateway port:

```sh
TAILCAT_ADDR_FILE=/absolute/private/browser-test/address.txt \
XDG_CONFIG_HOME=/absolute/private/browser-test/tailcat-config \
/absolute/path/to/tailcat serve --key=new 17987
```

The address is a private capability. Restrict its file/directory permissions and
do not route 8792/8793, a production relay, shell, or arbitrary port range.
Generate a private one-time bundle via the `0600` local admin socket:

```sh
node pwa/tailcat/admin.mjs pair /absolute/private/browser-test/state \
  /absolute/private/browser-test/address.txt https://APPROVED-STATIC-ORIGIN \
  /absolute/private/browser-test/pairing.txt 17987
qrencode -o /absolute/private/browser-test/pairing.png \
  < /absolute/private/browser-test/pairing.txt
```

Paste that file's contents into the HTTPS page's pairing field. The QR represents
plain pairing text, not a URL. Keep it outside the static directory. Use `list`
and `revoke` in `admin.mjs` to inspect/revoke browser devices. State/private files
are `0600`; the state directory should be `0700`. Pairing is bound to an exact
origin. Changing a temporary HTTPS hostname or losing browser keys requires a
fresh invitation. Restarting an ephemeral Tailcat sidecar changes its capability;
an address-update protocol and origin migration are not implemented in this draft.

## Verification and remaining gates

`npm run test:pwa` covers the legacy adapter and the new protocol/security tests.
The optional browser harness runs official WASM and an ephemeral Tailcat CLI
against **mock Pi only**; it deletes its isolated fixture afterward:

```sh
node pwa/tailcat/browser-smoke.mjs /absolute/wasm-artifact \
  /absolute/tailcat chromium 10
```

Install Playwright locally or set `PI_REMOTE_PLAYWRIGHT_MODULE` to a module path.
`PI_REMOTE_CHROMIUM` may select an existing Chromium executable. CI runs Chromium
with the same pinned CLI checksum, no Agent credentials or provider calls.
Local Chromium and desktop WebKit each passed 10 reconnects, key persistence,
large Unicode streaming, and a lost accepted-command reply followed by reload,
with zero duplicate prompts and zero API calls to the static origin. A local real
Pi metadata-only check verified that created empty sessions reopen with the same
ID/name; it sent no model prompt.

Before promotion: review authentication; approve an isolated real-Agent test;
test actual iPhone crypto/Worker/IndexedDB in Safari and Home Screen, lock/unlock,
backgrounding, WebKit termination and Wi-Fi/5G changes; measure startup, p50/p95
latency, at least 20 reconnects, completion rate and whole-process memory against
the unchanged Tailscale baseline. Desktop/CI passes are not this acceptance.
Preserve the original Echo test during that process and do not merge this Draft
PR or replace working PWA/native services based only on CI.
