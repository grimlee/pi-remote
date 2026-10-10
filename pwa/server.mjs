import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { publicSession } from "./registry.mjs";
import { PiService } from "./service.mjs";
import { Authentication, safeOrigin, readJson, stateDir } from "./security.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const files = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/recover", ["sw-reset.html", "text/html; charset=utf-8"]],
  ["/sw-reset.js", ["sw-reset.js", "text/javascript; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/recovery.js", ["recovery.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/sw.js", ["sw.js", "text/javascript; charset=utf-8"]],
  ["/manifest.webmanifest", ["manifest.webmanifest", "application/manifest+json"]],
  ["/icon.svg", ["icon.svg", "image/svg+xml"]],
  ...[180, 192, 512].map(size => ["/icon-" + size + ".png", ["icon-" + size + ".png", "image/png"]])
]);

function acceptsGzip(req) {
  return /(?:^|,)\s*gzip(?:\s*;\s*q=(?!0(?:\.0*)?(?:\s*,|\s*$))[0-9.]+)?\s*(?:,|$)/i.test(req?.headers["accept-encoding"] || "");
}

function json(res, status, value, headers = {}) {
  let body = Buffer.from(JSON.stringify(value));
  // Keep small/authentication responses uncompressed; compress large state snapshots.
  const compress = body.length >= 2048 && acceptsGzip(res.req);
  if (body.length >= 2048) headers = { Vary: "Accept-Encoding", ...headers };
  if (compress) {
    body = gzipSync(body, { level: 4 });
    headers = { ...headers, "Content-Encoding": "gzip" };
  }
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
    "Content-Length": body.length
  });
  res.end(body);
}
function error(res, status, code) {
  json(res, status, { error: code });
}
function securityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
}

export function createPwaServer(options = {}) {
  const dir = options.stateDir || stateDir();
  const auth = new Authentication({ dir, ...(options.token ? { token: options.token } : {}) });
  const service = new PiService({...options, stateDir: dir});
  const ledger = service.ledger;
  const refreshSessions = () => service.refreshSessions(100);
  const runnerFor = id => service.runnerFor(id);
  let stopped = false;

  const server = createServer(async (req, res) => {
    securityHeaders(res);
    const method = req.method || "GET";
    let url;
    try { url = new URL(req.url || "/", "http://localhost"); }
    catch { error(res, 400, "invalid_url"); return; }
    const pathname = url.pathname;

    if (method === "GET" && pathname === "/healthz") {
      json(res, 200, { ok: true });
      return;
    }
    if (method === "GET" && files.has(pathname)) {
      const [file, mime] = files.get(pathname);
      try {
        let data = await readFile(path.join(root, "public", file));
        const compressible = /^(?:text\/|application\/(?:json|manifest\+json))/.test(mime) || mime === "image/svg+xml";
        const compress = compressible && data.length >= 1024 && acceptsGzip(req);
        if (compress) data = gzipSync(data, { level: 4 });
        res.writeHead(200, {
          "Content-Type": mime,
          ...(compressible ? { Vary: "Accept-Encoding" } : {}),
          ...(compress ? { "Content-Encoding": "gzip" } : {}),
          "Content-Length": data.length,
          "Cache-Control": ["/recover", "/sw-reset.js"].includes(pathname) ? "no-store"
            : pathname === "/sw.js" ? "no-cache" : "max-age=0, must-revalidate"
        });
        res.end(data);
      } catch { error(res, 404, "not_found"); }
      return;
    }
    if (!pathname.startsWith("/api/")) {
      error(res, 404, "not_found");
      return;
    }
    if (method !== "GET" && !safeOrigin(req)) {
      error(res, 403, "invalid_origin");
      return;
    }
    if (pathname === "/api/login" && method === "POST") {
      try {
        const ip = req.socket.remoteAddress || "unknown";
        if (!auth.allowedAttempt(ip)) { error(res, 429, "too_many_attempts"); return; }
        const payload = await readJson(req, 4096);
        if (!auth.authenticate(payload?.token)) { error(res, 401, "invalid_token"); return; }
        auth.attempts.delete(ip);
        json(res, 200, { ok: true }, { "Set-Cookie": auth.cookie(req) });
      } catch (e) { error(res, e.status || 400, "invalid_request"); }
      return;
    }
    if (!auth.isAuthorized(req)) {
      error(res, 401, "not_authenticated");
      return;
    }
    if (pathname === "/api/auth" && method === "GET") {
      json(res, 200, { authenticated: true });
      return;
    }
    if (pathname === "/api/sessions" && method === "GET") {
      try {
        const sessions = await refreshSessions();
        json(res, 200, { sessions: sessions.map(publicSession) });
      } catch { error(res, 503, "sessions_unavailable"); }
      return;
    }

    if (method === "GET" && /^\/api\/commands\/[\w-]{10,100}$/.test(pathname)) {
      const receipt = ledger.get(pathname.split("/").pop());
      if (!receipt) { error(res, 404, "command_not_found"); return; }
      json(res, 200, { commandId: receipt.id, sessionId: receipt.sessionId, status: receipt.status });
      return;
    }

    const match = /^\/api\/sessions\/([^/]+)\/(state|events|commands)$/.exec(pathname);
    if (!match) { error(res, 404, "not_found"); return; }
    let id;
    try { id = decodeURIComponent(match[1]); }
    catch { error(res, 400, "invalid_session"); return; }
    if (!/^[\w-]{8,128}$/.test(id)) { error(res, 400, "invalid_session"); return; }
    const action = match[2];
    try {
      const runner = await runnerFor(id);
      if (action === "state" && method === "GET") {
        const snapshot = await runner.snapshot();
        json(res, 200, snapshot);
        return;
      }
      if (action === "events" && method === "GET") {
        const rawCursor = req.headers["last-event-id"] || url.searchParams.get("since") || String(runner.seq);
        const since = Number(rawCursor);
        if (!Number.isSafeInteger(since) || since < 0) { error(res, 400, "invalid_cursor"); return; }
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no"
        });
        res.flushHeaders();
        res.write(": connected\n\n");
        const send = entry => {
          if (res.destroyed || res.writableEnded) return;
          const writable = res.write("id: " + entry.id + "\nevent: " + entry.type
            + "\ndata: " + JSON.stringify(entry.data) + "\n\n");
          // A suspended browser must not grow an unbounded response buffer.
          if (!writable && res.writableLength > 2 * 1024 * 1024) res.end();
          if (entry.type === "reset" && entry.data?.reason === "rpc_exited") res.end();
        };
        const unsubscribe = runner.subscribe(send, since);
        const heartbeat = setInterval(() => {
          if (!res.destroyed && !res.writableEnded && !res.write("event: ping\ndata: {}\n\n")) res.end();
        }, 20000);
        const cleanup = () => { clearInterval(heartbeat); unsubscribe(); };
        res.once("close", cleanup);
        return;
      }
      if (action === "commands" && method === "POST") {
        const body = await readJson(req);
        if (!body || !["prompt", "abort"].includes(body.type)) {
          error(res, 400, "unsupported_command"); return;
        }
        if (body.type === "abort") {
          await runner.request("abort", {});
          json(res, 200, { status: "accepted" });
          return;
        }
        const result = await service.command(id, body);
        json(res, result.deduplicated ? 200 : result.status === "accepted" ? 202 : 503, result);
        return;
      }
      error(res, 405, "method_not_allowed");
    } catch (e) {
      error(res, e.status || 503, e.code || (e.status === 404 ? "session_not_found" : "backend_unavailable"));
    }
  });

  async function close() {
    if (stopped) return;
    stopped = true;
    service.close();
    server.closeIdleConnections();
    await new Promise(resolve => server.close(resolve));
  }
  return { server, auth, ledger, service, close };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const bind = process.env.PI_REMOTE_PWA_BIND || "127.0.0.1";
  if (!["127.0.0.1", "::1", "localhost"].includes(bind)) {
    throw new Error("PWA gateway refuses public binds; use an authenticated HTTPS reverse proxy");
  }
  const port = Number(process.env.PI_REMOTE_PWA_PORT || "8792");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PWA port");
  const app = createPwaServer();
  app.server.listen(port, bind, () => {
    console.log("Pi Remote PWA listening on http://" + bind + ":" + port);
    console.log("Use an HTTPS Tailnet-only reverse proxy (for example Tailscale Serve) for iPhone.");
    console.log("Read the PWA login token privately from " + path.join(stateDir(), "access-token"));
    console.log("The native Tailcat Quick Connect launcher remains npm start.");
  });
  const stop = () => { app.close().then(() => process.exit(0)); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
