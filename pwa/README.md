# Pi Remote PWA (experimental)

Installable iOS Safari PWA plus standalone Node 22+ HTTPS/SSE gateway for existing Pi RPC sessions. No frontend build dependencies.

## Tailcat preservation and boundary

The original iOS app, native Tailcat XCFramework, host identity, authorized device grants, encrypted relay, and npm start Quick Connect launcher remain unchanged. The PWA is an additional client; it does not replace the native Tailcat integration.

Safari cannot execute the existing native Tailcat bridge. The PWA uses HTTPS over a private tailnet connection or another trusted HTTPS reverse proxy and authenticates using a separate login credential. It does NOT reuse native Tailcat, the native QR grant, or the native Pi Remote end-to-end encryption protocol.

## Omarchy local start

    git switch feature/pwa-remote
    npm run pwa

The PWA listens on http://127.0.0.1:8792/. It deliberately refuses publicly exposed bind addresses. On startup a long random login token is printed; it persists in ~/.config/pi-remote/pwa/access-token with restrictive permissions. Override with PI_REMOTE_PWA_TOKEN (at least 24 characters), keep it private.

For iPhone, terminate TLS in a tailnet-only proxy, after verifying existing mappings are not disturbed:

    tailscale serve status
    tailscale serve --bg --https=10000 http://127.0.0.1:8792

Open https://YOUR-HOST.YOUR-TAILNET.ts.net:10000/ in Safari with tailnet access, and use Share > Add to Home Screen. Use a different private HTTPS route if 10000 is occupied. Do NOT reset Tailscale Serve or alter existing 443/8443 routes. Do NOT make this endpoint public via Funnel.

## Reliability

- Host Pi RPC subprocesses outlive browser disconnects and locked screens.
- SSE supports monotonic sequence IDs, bounded replay (1200 events / 2 MiB), and state refresh when replay is impossible.
- Browser reloads authoritative Pi state on reconnect, on foreground, and on turn completion.
- Prompts use a persistent command receipt/idempotency key, stored BEFORE dispatch. Ambiguous status is not automatically retried. This favors at-most-once dispatch rather than duplicate tool execution; it is not full exactly-once semantics.
- Host gateway process crashes can interrupt an in-flight Pi turn. Pi Durable checkpoints are NOT integrated.
- Simultaneous native and PWA RPC subprocesses editing the same persisted session are not recommended.

## First milestone scope

Working features: access-token login + HttpOnly/SameSite cookie, workspace/session discovery, read messages, prompt, abort, live streaming, foreground reconnection, Home Screen installation. Native iOS retains model selection, extension UI, encrypted native pairing, and full Tailcat Quick Connect. PWA model picker, image upload, new-session creation, and web-compatible Tailcat transport remain future work.

Test using npm run test:pwa. GitHub Actions validates syntax and runs mock-Pi RPC tests. The gateway keeps API data and provider keys out of service-worker caches. Never commit tokens, JSONL sessions, local Tailcat keys, or runtime logs.
