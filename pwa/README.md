# Pi Remote PWA (experimental)

The separate [authenticated browser Tailcat experiment](tailcat/README.md)
implements an optional Worker transport and isolated pairing gateway. The live
HTTPS/Tailscale installation and native client remain independent.

Installable iOS Safari PWA plus standalone Node 22+ HTTPS/SSE gateway for existing Pi RPC sessions. No frontend build dependencies.

## Tailcat preservation and boundary

The original iOS app, native Tailcat XCFramework, host identity, authorized device grants, encrypted relay, and npm start Quick Connect launcher remain unchanged. The PWA is an additional client; it does not replace the native Tailcat integration.

Safari cannot execute the existing native Tailcat bridge. The PWA uses HTTPS over a private tailnet connection or another trusted HTTPS reverse proxy and authenticates using a separate login credential. It does NOT reuse native Tailcat, the native QR grant, or the native Pi Remote end-to-end encryption protocol.

## Omarchy local start

    git switch feature/pwa-remote
    npm run pwa

The PWA listens on http://127.0.0.1:8792/. It deliberately refuses publicly exposed bind addresses. The login token is never printed to service logs; read it privately from the host token file. It persists in ~/.config/pi-remote/pwa/access-token with restrictive permissions. Override with PI_REMOTE_PWA_TOKEN (at least 24 characters), keep it private.

For iPhone, terminate TLS in a tailnet-only proxy, after verifying existing mappings are not disturbed:

    tailscale serve status
    tailscale serve --bg --https=10000 http://127.0.0.1:8792

Open https://YOUR-HOST.YOUR-TAILNET.ts.net:10000/ in Safari with tailnet access, and use Share > Add to Home Screen. Use a different private HTTPS route if 10000 is occupied. Do NOT reset Tailscale Serve or alter existing 443/8443 routes. Do NOT make this endpoint public via Funnel.

## Reliability

- Host Pi RPC subprocesses outlive browser disconnects and locked screens.
- SSE supports monotonic sequence IDs, bounded replay (1200 events / 2 MiB), and state refresh when replay is impossible.
- Browser persists the selected session ID and restores it after reload. It rebuilds SSE on foreground, network recovery, and stream failure, with bounded backoff. Offline reloads recover without re-pairing.
- Authoritative state includes the current partial assistant text, reconstructed from Pi 1.x delta-only RPC events, even when bounded event replay has expired.
- Versioned shell assets load directly from the service-worker cache on warm launches; bump the shell cache version whenever its assets change. Shell navigation ignores transport/version query parameters for cache lookup and uncached loads have an 8-second network deadline. Empty or unavailable caches return a valid offline response instead of a Safari null-response error.
- If an older worker prevents opening the app, visit `/recover` on the same private HTTPS origin. This uncached route unregisters only the root Pi Remote worker and deletes only Pi Remote shell caches, preserving authentication cookies, selected session IDs, pending command metadata, and unrelated caches. It returns to `/?transport=poll&v=6`.
- Authenticated startup uses the session list directly, avoiding a separate auth-check round trip. HTML, JavaScript, CSS and large state responses use gzip when supported, retaining complete message history over slow mobile links.
- iPhone/iPad default to short HTTPS state requests every three seconds while idle and every second while Pi is working, avoiding long-lived SSE on mobile VPN paths. Failed reads retry with bounded backoff. Use `?transport=poll` to opt into this mode on other browsers or `?transport=stream` for an explicit SSE test.
- Desktop SSE has an 8-second connection deadline and a 45-second heartbeat deadline. A stalled stream switches to polling for the remainder of the page session, without an endless stream reconnect loop. Commands are never automatically replayed.
- Sending/aborting takes priority over history downloads. Authenticated receipt reconciliation clears an unchanged draft once an ambiguous command is confirmed as accepted.
- Browser reloads authoritative Pi state on reconnect, on foreground, and on turn completion.
- Browser stores pending command IDs and message fingerprints (never prompt text or credentials) before dispatch, and queries authenticated receipts on recovery. Storage-disabled browsers cannot retain this metadata across reloads.
- Prompts use a persistent command receipt/idempotency key, stored BEFORE dispatch. Ambiguous status is not automatically retried. This favors at-most-once dispatch rather than duplicate tool execution; it is not full exactly-once semantics.
- Host gateway process crashes can interrupt an in-flight Pi turn. Pi Durable checkpoints are NOT integrated.
- Simultaneous native and PWA RPC subprocesses editing the same persisted session are not recommended.

## First milestone scope

Working features: access-token login + HttpOnly/SameSite cookie, workspace/session discovery, read messages, prompt, abort, live streaming, foreground reconnection, Home Screen installation. Native iOS retains model selection, extension UI, encrypted native pairing, and full Tailcat Quick Connect. PWA model picker, image upload, new-session creation, and web-compatible Tailcat transport remain future work.

Test using npm run test:pwa. GitHub Actions validates syntax and runs mock-Pi RPC tests. The gateway keeps API data and provider keys out of service-worker caches. Never commit tokens, JSONL sessions, local Tailcat keys, or runtime logs.

## Dedicated user service

Use a separate checkout and copy `pwa/pi-remote-pwa.service.example` to
`~/.config/systemd/user/pi-remote-pwa.service`. Replace the Node and Pi paths with
absolute paths resolved on your host (`command -v node` and `command -v pi`).
The example uses an isolated session directory to prevent PWA and native RPC
processes writing the same session. Create a disposable named session there with
`PI_CODING_AGENT_SESSION_DIR=~/.local/state/pi-remote-pwa/sessions pi --name "iPhone PWA Test"`
and send a prompt before exiting, so Pi persists it. The PWA discovers only this
directory; use it for subsequent PWA-owned sessions too.

    mkdir -p ~/.local/state/pi-remote-pwa/sessions
    chmod 700 ~/.local/state/pi-remote-pwa ~/.local/state/pi-remote-pwa/sessions
    systemd-analyze --user verify ~/.config/systemd/user/pi-remote-pwa.service
    systemctl --user daemon-reload
    systemctl --user enable --now pi-remote-pwa.service
    systemctl --user status pi-remote-pwa.service

Check `loginctl show-user "$USER" -p Linger` before changing anything. Existing
linger needs no modification. Read `~/.config/pi-remote/pwa/access-token` locally
for first login; never put it in a URL, issue, screenshot, commit, or service unit.
The file is created with mode `0600`, and the authentication cookie persists
across service restarts. The service runs after the browser disconnects. Restart
recovery restores persisted messages, cookies, and command receipts; it does
not resume interrupted tool execution.

The manifest includes PNG icons and an Apple touch icon for Safari Home Screen
installation. The service worker caches only static shell assets. Final remote
acceptance still requires the actual iPhone: install to Home Screen, lock/unlock,
change Wi-Fi/5G, and verify return to the same session without command resubmission.

Automated tests cover authentication/error paths, bounded replay, Pi 1.x delta
reconstruction, browser reload and network recovery, ambiguous command IDs, and
long text restoration. These tests use a fake Pi or browser harness; they must
be supplemented by a real Pi prompt/background-tool/abort smoke test on the host.

## Mobile UX experiment (`feature/pwa-mobile-ux`)

This iteration keeps the Pi transport and server behavior unchanged. It adds a dismissible mobile session drawer with a backdrop, session search by name/workspace/model, collapsible workspace groups, short workspace labels with full-path tooltips, per-message copy, an explicit jump-to-latest control, and auto-sizing message input. The iOS polling renderer now skips complete transcript DOM replacement when the authoritative message list is unchanged and sets (rather than appends) identical live assistant snapshots. These changes aim to reduce large-output scroll jumps without changing command idempotency or recovery semantics.

To validate, use `npm run test:pwa`, then verify iPhone Safari and standalone PWA behavior with keyboard shown, screen locked/unlocked, Wi-Fi/5G transitions and >10K-token replies. The service worker shell cache version is `v7`. Deploy from a separate checkout; do not overwrite the currently working live gateway without explicit user approval.


### Parallel UX deployments and validation

When running two PWA gateways on the same hostname with different HTTPS ports,
configure a distinct `PI_REMOTE_PWA_COOKIE_NAME` (for example `pr_ux_session`)
for the second service, as well as separate state and Pi session directories.
Browser cookies are shared across ports; the default `pr_session` is unchanged.
This keeps the stable and UX gateways authenticated together without replacing
one another's cookie. Service-worker caches and browser storage remain separated
by HTTPS origin.

The mobile shell follows `visualViewport.height` when available and limits the
composer to that viewport. The jump-to-latest control follows composer height.
Authoritative snapshots also remove vanished live text when persisted messages
have not changed. These fixes use shell cache `v7.2`; `/recover` preserves the
login cookie and selected-session/pending-command metadata.

Host validation includes real Pi replies above 10K output tokens, a detached
background tool task, duplicate-command protection, WebKit mobile layout/recovery,
and a bounded browser transcript stress sample. Actual iPhone keyboard, clipboard,
lock/unlock, Wi-Fi/cellular transitions and Home Screen lifecycle still require
physical-device acceptance. The transcript renders the latest 160 messages;
older messages remain in Pi storage, with history pagination left for later work.
