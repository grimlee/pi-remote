# Tailcat browser PoC — no Tailscale app required

This branch demonstrates **real Tailcat Go WASM in a browser**, not a native iOS bridge, a Tailnet VPN or a Tailcat-named HTTP reverse proxy. It is intentionally isolated from Pi, existing PWA APIs, the native Tailcat Quick Connect and your existing HTTPS/Tailscale Serve routes.

## Upstream evidence and version

- Official browser demo: https://tailscale.github.io/tailcat/
- Official Go WASM bridge: https://github.com/tailscale/tailcat/blob/v0.6.0/web/main_js.go
- Browser WebRTC is not yet part of official Tailcat: https://github.com/tailscale/tailcat/issues/4
- Community WebRTC fork https://github.com/tailfile/tailcat-wasm is explicitly alpha/unaudited; **not used** in this PoC.
- Pin upstream to v0.6.0 commit **790406204c002a6f109ef7c6a30a436601a1f6a8**, matching the existing native iOS bridge. Build assets using Go **1.27.1**. Go WASM and Go's wasm_exec.js **must match**.

The official `tailcatDial({addr, port, derpMapURL})` API exposes an encrypted, pull-based bidirectional TCP byte stream over Tailcat's DERP websocket connection. In a browser, direct UDP NAT traversal is not available. The CLI host may use either direct paths or DERP for native peers, but the browser peer currently uses **DERP-only**.

## What this PoC proves

The browser boots the official Tailcat WASM, dials an **ephemeral, isolated** Tailcat server running on Omarchy, sends a random challenge, and verifies the exact reply over the tunnel. It does not expose Pi RPC, session files or credentials.

The probe uses **no native app and no Tailscale app/Shadowrocket extension**. Browser HTML + WASM must still be loaded from a normal HTTPS origin; this HTTPS origin can be static GitHub Pages and does **not** receive Pi data. Do not encode Tailcat address secrets in query strings, URLs, GitHub issues or web analytics.

### Step 1 — Build and get static browser files

GitHub Actions: **Tailcat browser WASM PoC** builds the official pinned v0.6.0 Go WASM and packages these static files into a downloadable artifact:

- index.html + client.js from this repo
- wasm_exec.js + main.wasm.gz generated from pinned upstream
- TAILCAT-LICENSE

This artifact is **not automatically deployed to public Pages**. The owner should publish *only these static files*, with their hashes retained, to a trusted HTTPS static origin such as GitHub Pages (or another private trusted HTTPS host). Public static program hosting does **not** expose the Tailcat Host.

For local desktop tests, extract artifact into a directory and serve on localhost:

    python3 -m http.server 5175 --bind 127.0.0.1 --directory tailcat-browser-dist

Go WASM can be slow to load for the first time on mobile; the official compressed artifact is large. Profile startup memory, bootstrap latency and CPU before any production integration. You must validate *actual Safari on an iPhone*; upstream's automated browser tests use Chromium.

### Step 2 — Start the isolated probe server on Omarchy

In a **separate checkout of this branch**, without touching running services:

    node pwa/tailcat-poc/probe-server.mjs

It listens ONLY on `127.0.0.1:17984`. Confirm the port is free first. In a separate terminal, using the **already installed** Tailcat v0.6.0 CLI:

    tailcat serve --key=new 17984

This creates an *ephemeral* Tailcat address; it does **not** reuse the key or address used by the original native iOS Pi Remote client. The existing 443/8443 Serve routes and 8792/8793 PWA gateways are untouched.

The printed `tc…` address is sensitive: **copy privately** into the PoC browser page, not into a URL or log. The test web page defaults to port 17984. The browser executes the Go WASM `tailcatDial` and must receive a `PONG` for its fresh 128-bit nonce. Never share a Tailcat private key or captured full address in public.

### Step 3 — Test on a real iPhone, with VPN/Tailscale fully disabled

Open the trusted static HTTPS page in Safari, with **Shadowrocket/Tailscale VPN or extensions disabled**, paste the ephemeral `tc…` address and tap Connect. Record privately:

- HTTPS static page loading and WASM initialization time.
- Time to Tailcat connection established and challenge verified.
- Failure frequency over 20 trials and after lock/unlock, Safari tab reload and Wi-Fi/5G changes.
- DERP connectivity on both Wi-Fi and cellular, including long-lived connection behavior and Safari memory pressure.
- Compare against the current PWA/Tailscale baseline; do **not** assume DERP-only is faster.

If the page cannot load from a trusted static HTTPS origin without Tailscale, the test does **not** prove full VPN-independent use.

## Next: actual Agent transport (not yet implemented)

Only after **real iPhone** Tailcat WASM-to-Host works:

1. Use a reusable Tailcat session bridge or an authenticated framed API transport under a new isolated port. Avoid reimplementing arbitrary HTTP parsing or blindly forwarding existing bearer/cookie endpoints.
2. Reuse the current server-side Pi sessions/RPC and idempotency logic through shared internal functions. Do not fork the Agent logic.
3. Create a **one-time QR pairing** protocol with a device-bound key pair and Host-authoritative device grants/revocation. Tailcat addresses are sensitive reachability capabilities, **not sufficient standalone authorization**; do not persist a static PWA login token as plaintext localStorage.
4. Serve only frontend JS/WASM via static HTTPS (or cached PWA shell); proxy *no* private Agent data through that static host. Browser transport must be same-origin-independent and should not depend on public backend or tailnet.
5. Worker-host the Go WASM before shipping long streaming conversations, with strict memory/backpressure budgets. Preserve fallback Tailscale PWA and native Tailcat client until proven stable.
6. Design versioned PWA cache updates, dynamic service worker permissions and offline states; backgrounded iOS Safari may suspend the connection, so resynchronize on resume. Preserve exactly-once command dispatch protections; “successful Tailcat ping” is not durable Agent execution.

**Do not** auto-deploy an unauthenticated Agent server over Tailcat. PoC echo only is intentionally limited.

## Test

    node --test pwa/tailcat-poc/probe.test.mjs

The separate GitHub Actions workflow runs these tests and builds the official Go/WASM into an artifact. Passing those tests is *not* proof of working WebKit/Tailcat connectivity until the real iPhone exercises it.
