// Tailcat's pinned Go 1.27.1 js/wasm exposes tailcatDial. This PoC only
// checks an isolated challenge/response echo. It does NOT proxy the Pi API.
const $ = id => document.getElementById(id);
const button = $("connect");
const status = $("status");
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const DERP_MAP = "https://tailcat.dev/derpmap.json";

function show(text) { status.textContent = text; }
async function load() {
  if (location.protocol !== "https:" && !["127.0.0.1", "localhost"].includes(location.hostname)) {
    throw new Error("WASM must be loaded from a trusted HTTPS origin");
  }
  if (!globalThis.WebAssembly || !globalThis.Go || !globalThis.DecompressionStream) {
    throw new Error("This browser lacks the required WebAssembly/Go/DecompressionStream APIs");
  }
  const since = performance.now();
  show("Downloading Tailcat WASM…");
  const gz = await fetch("./main.wasm.gz", { cache: "force-cache" });
  if (!gz.ok || !gz.body) throw new Error("Missing pinned main.wasm.gz: HTTP " + gz.status);
  // Static hosting serves *.gz as a raw binary (without Content-Encoding).
  // Stream decompression so we do not hold two full WASM copies in JS memory.
  const stream = gz.body.pipeThrough(new DecompressionStream("gzip"));
  const response = new Response(stream, { headers: { "Content-Type": "application/wasm" } });
  const go = new Go();
  const ready = new Promise(resolve => { globalThis.onTailcatReady = resolve; });
  const { instance } = await WebAssembly.instantiateStreaming(response, go.importObject);
  void go.run(instance);
  await ready;
  show("WASM loaded in " + Math.round(performance.now() - since) + " ms.\nReady for DERP-only reachability test.");
  button.disabled = false;
  button.textContent = "连接 Omarchy Echo 服务";
}

async function probe() {
  const addr = $("addr").value.trim();
  const port = Number($("port").value);
  if (!/^tc[A-Za-z0-9_-]{20,5000}$/.test(addr) ||
      !Number.isInteger(port) || port < 1024 || port > 65535) {
    show("Invalid Tailcat address or port");
    return;
  }
  button.disabled = true;
  let conn;
  try {
    const since = performance.now();
    show("Connecting via Tailcat DERP… (initial handshake may take up to ~60 s)");
    conn = await globalThis.tailcatDial({ addr, port, derpMapURL: DERP_MAP });
    const connectedMs = Math.round(performance.now() - since);
    const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
    const nonce = Array.from(nonceBytes, b => b.toString(16).padStart(2, "0")).join("");
    await conn.write(encoder.encode("PING " + nonce + "\n"));
    await conn.closeWrite();
    let reply = "";
    for (let i = 0; i < 4; i++) {
      const chunk = await conn.read();
      if (chunk === null) break;
      reply += decoder.decode(chunk, { stream: true });
      if (reply.length > 128) throw new Error("Unexpected oversized reply");
    }
    if (reply !== "PONG " + nonce + "\n") throw new Error("Unexpected host reply");
    show("Tailcat browser-to-Host verified!\n"
      + "WASM + DERP handshake: " + connectedMs + " ms\n"
      + "Full challenge round trip: " + Math.round(performance.now() - since) + " ms\n"
      + "No VPN/Tailscale client used by this page.");
  } catch (error) {
    // Never include the address or credentials in errors/logs.
    show("Connection failed. Verify isolated host sidecar and DERP reachability.\n"
      + String(error?.message || "unknown error").replace(/tc[A-Za-z0-9_-]{20,}/g, "tc[REDACTED]"));
  } finally {
    if (conn) conn.close();
    button.disabled = false;
  }
}
button.addEventListener("click", () => { void probe(); });
load().catch(err => {
  show("WASM initialization failed: " + err.message);
  button.disabled = true;
});
