import { createHmac, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, openSync, fsyncSync, closeSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "pi-remote", "pwa");
export function stateDir() {
  const dir = process.env.PI_REMOTE_PWA_STATE_DIR || CONFIG_DIR;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export class Authentication {
  constructor(options = {}) {
    this.dir = options.dir || stateDir();
    this.cookieName = options.cookieName || process.env.PI_REMOTE_PWA_COOKIE_NAME || "pr_session";
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(this.cookieName)) throw new Error("Invalid PWA cookie name");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const pathname = path.join(this.dir, "access-token");
    this.token = options.token || process.env.PI_REMOTE_PWA_TOKEN;
    if (!this.token) {
      try { this.token = readFileSync(pathname, "utf8").trim(); }
      catch (error) {
        if (error.code !== "ENOENT") throw error;
        this.token = randomBytes(24).toString("base64url");
        writeFileSync(pathname, this.token + "\n", { mode: 0o600, flag: "wx" });
      }
    }
    if (this.token.length < 24) throw new Error("PWA access token must be at least 24 characters");
    this.cookieValue = createHmac("sha256", this.token).update("pi-remote-pwa-session-v1").digest("base64url");
    this.attempts = new Map();
  }
  authenticate(token) {
    if (typeof token !== "string" || token.length > 1024) return false;
    const a = createHash("sha256").update(token).digest();
    const b = createHash("sha256").update(this.token).digest();
    return timingSafeEqual(a, b);
  }
  allowedAttempt(key) {
    const now = Date.now();
    const entry = this.attempts.get(key);
    if (!entry || now - entry.time > 15 * 60_000) {
      this.attempts.set(key, { time: now, count: 1 });
      return true;
    }
    entry.count++;
    return entry.count <= 8;
  }
  isAuthorized(req) {
    const match = new RegExp("(?:^|;\\s*)" + this.cookieName + "=([^;]+)").exec(req.headers.cookie || "");
    if (!match) return false;
    const value = match[1];
    if (typeof value !== "string" || value.length !== this.cookieValue.length) return false;
    const actual = Buffer.from(value);
    const expected = Buffer.from(this.cookieValue);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
  cookie(req) {
    const host = String(req.headers["x-forwarded-host"] || req.headers.host || "");
    const protocol = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
    const local = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host);
    const secure = protocol === "https" || !local;
    return this.cookieName + "=" + this.cookieValue
      + "; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000"
      + (secure ? "; Secure" : "");
  }
}

export function safeOrigin(req) {
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const incoming = new URL(origin);
    const allowedHosts = [req.headers.host, req.headers["x-forwarded-host"]]
      .filter(Boolean).map(x => String(x).toLowerCase());
    return ["http:", "https:"].includes(incoming.protocol)
      && allowedHosts.includes(incoming.host.toLowerCase());
  } catch { return false; }
}

export function readJson(req, maxBytes = 65536) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error("Request is too large"), { status: 413 }));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => {
      if (size > maxBytes) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(Object.assign(new Error("Invalid JSON"), { status: 400 })); }
    });
    req.on("error", reject);
  });
}

export class CommandLedger {
  constructor(dir = stateDir()) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = path.join(dir, "command-receipts.jsonl");
    this.items = new Map();
    try {
      for (const line of readFileSync(this.file, "utf8").split("\n")) {
        if (!line) continue;
        try {
          const item = JSON.parse(line);
          if (typeof item.id === "string") this.items.set(item.id, item);
        } catch {}
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  get(id) { return this.items.get(id); }
  save(item) {
    // Durably record the idempotency key BEFORE sending a prompt to Pi.
    const fd = openSync(this.file, "a", 0o600);
    try {
      appendFileSync(fd, JSON.stringify(item) + "\n");
      fsyncSync(fd);
    } finally { closeSync(fd); }
    this.items.set(item.id, item);
  }
}
