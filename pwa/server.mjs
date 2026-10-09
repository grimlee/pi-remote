import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { discoverSessions, publicSession, PiRunner, DEFAULT_SESSION_DIR } from "./registry.mjs";
import { Authentication, CommandLedger, safeOrigin, readJson, stateDir } from "./security.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const files = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/sw.js", ["sw.js", "text/javascript; charset=utf-8"]],
  ["/manifest.webmanifest", ["manifest.webmanifest", "application/manifest+json"]],
  ["/icon.svg", ["icon.svg", "image/svg+xml"]]
]);

function json(res, status, value, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers
  });
  res.end(JSON.stringify(value));
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
  const ledger = new CommandLedger(dir);
  const sessionRoot = options.sessionDir || DEFAULT_SESSION_DIR;
  const executable = options.executable || process.env.PI_REMOTE_PWA_PI_COMMAND || "pi";
  const runners = new Map();
  let records = new Map();
  let stopped = false;

  async function refreshSessions() {
    const list = await discoverSessions(sessionRoot);
    records = new Map(list.map(s => [s.id, s]));
    return list;
  }

  async function runnerFor(id) {
    let session = records.get(id);
    if (!session) {
      await refreshSessions();
      session = records.get(id);
    }
    if (!session) throw Object.assign(new Error("Session not found"), { status: 404 });
    let runner = runners.get(id);
    if (runner && runner.session.generation !== session.generation) {
      runner.stop();
      runners.delete(id);
      runner = null;
    }
    if (!runner || runner.dead) {
      if (runners.size >= 8) {
        const idle = [...runners.entries()].find(([, value]) => !value.busy);
        if (!idle) throw Object.assign(new Error("Too many active sessions"), { status: 429 });
        idle[1].stop();
        runners.delete(idle[0]);
      }
      runner = new PiRunner(session, {
        executable,
        onClosed(closed) {
          if (runners.get(id) === closed) runners.delete(id);
        }
      });
      runners.set(id, runner);
      runner.ready = runner.start();
    }
    await runner.ready;
    return runner;
  }

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
        const data = await readFile(path.join(root, "public", file));
        res.writeHead(200, {
          "Content-Type": mime,
          "Cache-Control": pathname === "/sw.js" ? "no-cache" : "max-age=0, must-revalidate"
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

    const match = /^\/api\/sessions\/([^/]+)\/(state|events|commands)$/.exec(pathname);
    if (!match) { error(res, 404, "not_found"); return; }
    const id = decodeURIComponent(match[1]);
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
        res.write(": connected\n\n");
        const send = entry => {
          if (res.destroyed || res.writableEnded) return;
          res.write("id: " + entry.id + "\nevent: " + entry.type
            + "\ndata: " + JSON.stringify(entry.data) + "\n\n");
          if (entry.type === "reset" && entry.data?.reason === "rpc_exited") res.end();
        };
        const unsubscribe = runner.subscribe(send, since);
        const heartbeat = setInterval(() => {
          if (!res.destroyed) res.write(": heartbeat\n\n");
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
        if (typeof body.message !== "string" || !body.message.trim() || body.message.length > 50000
          || typeof body.commandId !== "string" || !/^[\w-]{10,100}$/.test(body.commandId)) {
          error(res, 400, "invalid_prompt"); return;
        }
        const hash = createHash("sha256").update(id + "\n" + body.message).digest("hex");
        const prior = ledger.get(body.commandId);
        if (prior) {
          if (prior.hash !== hash || prior.sessionId !== id) {
            error(res, 409, "command_id_conflict"); return;
          }
          json(res, 200, { status: prior.status, deduplicated: true, commandId: body.commandId });
          return;
        }
        const receipt = { id: body.commandId, sessionId: id, hash, status: "unknown", at: Date.now() };
        ledger.save(receipt);
        try {
          await runner.request("prompt", { message: body.message }, 30000);
          receipt.status = "accepted";
          ledger.save(receipt);
          json(res, 202, { status: "accepted", commandId: body.commandId });
        } catch {
          // Unknown is intentionally not re-dispatched automatically: at-most-once over double execution.
          json(res, 503, { status: "unknown", commandId: body.commandId });
        }
        return;
      }
      error(res, 405, "method_not_allowed");
    } catch (e) {
      error(res, e.status || 503, e.status === 404 ? "session_not_found" : "backend_unavailable");
    }
  });

  async function close() {
    if (stopped) return;
    stopped = true;
    for (const runner of runners.values()) runner.stop();
    await new Promise(resolve => server.close(resolve));
  }
  return { server, auth, ledger, close };
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
    console.log("PWA login token (keep private): " + app.auth.token);
    console.log("The native Tailcat Quick Connect launcher remains npm start.");
  });
  const stop = () => { app.close().then(() => process.exit(0)); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
