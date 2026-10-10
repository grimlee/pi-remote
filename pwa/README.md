# Pi Remote PWA (experimental)

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
- Large state responses use gzip when supported, retaining complete message history over slow mobile links.
- SSE has an 8-second connection deadline and a 45-second heartbeat deadline. Stalled streams fall back to three-second authoritative state polling while reconnecting; commands are never automatically replayed.
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
