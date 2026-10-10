import test from "node:test";
import { get } from "node:http";
import { gunzipSync } from "node:zlib";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { discoverSessions, PiRunner } from "../registry.mjs";
import { Authentication, CommandLedger, safeOrigin } from "../security.mjs";
import { createPwaServer } from "../server.mjs";

const fakePi = fileURLToPath(new URL("./fake-pi", import.meta.url));
const token = "test-access-token-for-pwa-remote-0123456789";
async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "pwa-remote-test-"));
  const sessions = path.join(base, "sessions", "workspace");
  const config = path.join(base, "config");
  await mkdir(sessions, { recursive: true });
  await mkdir(config);
  await writeFile(path.join(sessions, "session.jsonl"), [
    JSON.stringify({ type: "session", id: "session_test_12345", timestamp: "2026-10-09T00:00:00.000Z", cwd: base }),
    JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "Hello from a session" }] } }),
    JSON.stringify({ type: "session_info", name: "Test coding session" })
  ].join("\n") + "\n");
  return { base, sessions: path.dirname(sessions), config };
}

test("session discovery keeps immutable generation", async () => {
  const f = await fixture();
  const list = await discoverSessions(f.sessions);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "session_test_12345");
  assert.equal(list[0].name, "Test coding session");
  assert.equal(list[0].generation, Date.parse("2026-10-09T00:00:00.000Z"));
});

test("auth, private cookie and origin checks", async () => {
  const f = await fixture();
  const auth = new Authentication({ dir: f.config, token });
  assert.equal(auth.authenticate(token), true);
  assert.equal(auth.authenticate("wrong"), false);
  const cookie = auth.cookie({ headers: { host: "127.0.0.1:8792" } });
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.equal(auth.isAuthorized({ headers: { cookie: cookie.split(";")[0] } }), true);
  assert.equal(auth.isAuthorized({ headers: { cookie: "pr_session=" + "é".repeat(auth.cookieValue.length) } }), false);
  assert.equal(safeOrigin({ headers: { origin: "https://evil.invalid", host: "127.0.0.1:8792" } }), false);
});

test("PiRunner supports event replay after detached subscriber", async () => {
  const f = await fixture();
  const session = (await discoverSessions(f.sessions))[0];
  const runner = new PiRunner(session, { executable: fakePi });
  await runner.start();
  try {
    assert.ok(Array.isArray((await runner.snapshot()).messages));
    await runner.request("prompt", { message: "try" });
    await new Promise(resolve => setTimeout(resolve, 100));
    const replay = [];
    runner.subscribe(event => replay.push(event), 0)();
    assert.ok(replay.some(event => event.type === "rpc"));
    assert.ok((await runner.snapshot()).messages.some(message => message.role === "assistant"));
    const reset = [];
    runner.subscribe(event => reset.push(event), 999999)();
    assert.equal(reset[0].type, "reset");
  } finally { runner.stop(); }
});

test("PWA API authenticates, streams, and deduplicates prompt IDs", async t => {
  const f = await fixture();
  const app = createPwaServer({ token, stateDir: f.config, sessionDir: f.sessions, executable: fakePi });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.close());
  const base = "http://127.0.0.1:" + app.server.address().port;
  assert.equal((await fetch(base + "/api/sessions")).status, 401);
  assert.equal((await fetch(base + "/api/login", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.invalid" },
    body: JSON.stringify({ token })
  })).status, 403);
  const login = await fetch(base + "/api/login", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token })
  });
  assert.equal(login.status, 200);
  const headers = { Cookie: login.headers.get("set-cookie").split(";")[0] };
  for (let i = 0; i < 10; i++) {
    assert.equal((await fetch(base + "/api/login", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token })
    })).status, 200, "successful logins must not lock out the Tailnet proxy");
  }
  assert.equal((await fetch(base + "/api/sessions/%ZZ/state", { headers })).status, 400);
  const listing = await (await fetch(base + "/api/sessions", { headers })).json();
  assert.equal(listing.sessions.length, 1);
  assert.equal(listing.sessions[0].file, undefined);
  const url = base + "/api/sessions/" + listing.sessions[0].id;
  const initial = await (await fetch(url + "/state", { headers })).json();
  assert.ok(initial.messages.length);
  const message = { type: "prompt", commandId: "unique-command-id-000001", message: "only once" };
  const opts = { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(message) };
  assert.equal((await fetch(url + "/commands", opts)).status, 202);
  assert.equal((await (await fetch(url + "/commands", opts)).json()).deduplicated, true);
  assert.equal((await fetch(url + "/commands", { ...opts, body: JSON.stringify({ ...message, message: "different" }) })).status, 409);
  await new Promise(resolve => setTimeout(resolve, 100));
  const state = await (await fetch(url + "/state", { headers })).json();
  assert.equal(state.messages.filter(m => m.role === "user" && m.content?.[0]?.text === "only once").length, 1);
  const controller = new AbortController();
  const streamed = await fetch(url + "/events?since=0", { headers, signal: controller.signal });
  assert.equal(streamed.status, 200);
  const reader = streamed.body.getReader();
  let buffer = "";
  for (let i = 0; i < 5 && !buffer.includes("event: rpc"); i++) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += new TextDecoder().decode(chunk.value);
  }
  assert.match(buffer, /event: rpc/);
  controller.abort();
  await reader.cancel().catch(() => {});
  const receipt = await (await fetch(base + "/api/commands/" + message.commandId, { headers })).json();
  assert.equal(receipt.status, "accepted");
  assert.equal(receipt.hash, undefined);
  assert.equal((await fetch(base + "/api/commands/" + message.commandId)).status, 401);
  const ledger = new CommandLedger(f.config);
  assert.equal(ledger.get(message.commandId).status, "accepted");
  assert.doesNotMatch(await readFile(path.join(f.config, "command-receipts.jsonl"), "utf8"), /only once/);
});


test("tool turn_end keeps the runner busy and in-flight text survives bounded replay eviction", async () => {
  const runner = new PiRunner({});
  const consume = event => runner.consume(Buffer.from(JSON.stringify(event) + "\n"));
  consume({ type: "agent_start" });
  consume({ type: "turn_end" });
  assert.equal(runner.busy, true);
  const text = "长输出🙂".repeat(25000);
  consume({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text }] } });
  for (let i = 0; i < 1300; i++) runner.publish("rpc", { type: "message_update", delta: "test" });
  assert.ok(runner.events.length <= 1200);
  assert.ok(runner.eventBytes <= 2 * 1024 * 1024);
  assert.equal(runner.liveMessage.content[0].text, text);
  const replay = []; runner.subscribe(event => replay.push(event), 0)();
  assert.equal(replay[0].type, "reset");
  consume({ type: "agent_settled" });
  assert.equal(runner.busy, false);
  assert.equal(runner.liveMessage, null);
});


test("Pi 1.x delta-only streaming reconstructs a detached assistant without mutating replay", () => {
  const runner = new PiRunner({});
  const consume = event => runner.consume(Buffer.from(JSON.stringify(event) + "\n"));
  consume({ type: "message_start", message: { role: "assistant", content: [] } });
  const initialBytes = runner.eventBytes;
  consume({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "first " } });
  consume({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "second" } });
  assert.equal(runner.liveMessage.content[0].text, "first second");
  assert.deepEqual(runner.events[0].data.message.content, []);
  assert.ok(runner.eventBytes > initialBytes);
  consume({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "authoritative final text" } });
  assert.equal(runner.liveMessage.content[0].text, "authoritative final text");
  consume({ type: "agent_start" });
  consume({ type: "agent_end", willRetry: true });
  assert.equal(runner.busy, true);
  consume({ type: "agent_settled" });
  assert.equal(runner.liveMessage, null);
});


test("large session snapshots compress on the wire and retain complete history", async t => {
  const f = await fixture();
  const app = createPwaServer({ token, stateDir: f.config, sessionDir: f.sessions, executable: fakePi });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.close());
  const base = "http://127.0.0.1:" + app.server.address().port;
  const cookie = app.auth.cookie({ headers: { host: "localhost" } }).split(";")[0];
  const headers = { Cookie: cookie };
  const sessions = await (await fetch(base + "/api/sessions", { headers })).json();
  const url = base + "/api/sessions/" + sessions.sessions[0].id;
  const message = "long transport fixture ".repeat(1000);
  assert.equal((await fetch(url + "/commands", {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "prompt", message, commandId: "long-transport-command-0001" })
  })).status, 202);
  await new Promise(resolve => setTimeout(resolve, 80));
  const raw = await new Promise((resolve, reject) => {
    get(url + "/state", { headers: { ...headers, "Accept-Encoding": "gzip" } }, res => {
      const chunks = []; res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    }).on("error", reject);
  });
  assert.equal(raw.headers["content-encoding"], "gzip");
  assert.equal(raw.headers["cache-control"], "no-store");
  assert.equal(raw.headers.vary, "Accept-Encoding");
  const expanded = gunzipSync(raw.body);
  assert.ok(raw.body.length < expanded.length / 4);
  const data = JSON.parse(expanded);
  assert.ok(data.messages.some(m => m.content?.[0]?.text === message));
  const uncompressed = await fetch(url + "/state", { headers: { ...headers, "Accept-Encoding": "gzip;q=0, identity" } });
  assert.equal(uncompressed.headers.get("content-encoding"), null);
  assert.equal((await uncompressed.json()).messages.length, data.messages.length);
});

test("recovery entry and external script bypass shell paths with no-store and CSP", async t => {
  const f = await fixture();
  const app = createPwaServer({ token, stateDir: f.config, sessionDir: f.sessions, executable: fakePi });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.close());
  const base = "http://127.0.0.1:" + app.server.address().port;
  const recovery = await fetch(base + "/recover");
  assert.equal(recovery.status, 200);
  assert.equal(recovery.headers.get("cache-control"), "no-store");
  assert.match(recovery.headers.get("content-security-policy"), /script-src 'self'/);
  assert.match(await recovery.text(), /src="\/sw-reset.js"/);
  const script = await fetch(base + "/sw-reset.js");
  assert.equal(script.status, 200);
  assert.equal(script.headers.get("cache-control"), "no-store");
  assert.doesNotMatch(await script.text(), /localStorage\.(clear|removeItem)|document\.cookie\s*=/);
});

test("shell resources compress without changing their contents or MIME types", async t => {
  const f = await fixture();
  const app = createPwaServer({ token, stateDir: f.config, sessionDir: f.sessions, executable: fakePi });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.close());
  const base = "http://127.0.0.1:" + app.server.address().port;
  for (const route of ["/", "/app.js", "/styles.css", "/sw.js"]) {
    const raw = await new Promise((resolve, reject) => {
      get(base + route, { headers: { "Accept-Encoding": "gzip" } }, response => {
        const chunks = [];
        response.on("data", chunk => chunks.push(chunk));
        response.on("end", () => resolve({ headers: response.headers, body: Buffer.concat(chunks) }));
        response.on("error", reject);
      }).on("error", reject);
    });
    const identity = await fetch(base + route, { headers: { "Accept-Encoding": "gzip;q=0, identity" } });
    assert.equal(raw.headers["content-encoding"], "gzip");
    assert.equal(raw.headers.vary, "Accept-Encoding");
    assert.equal(raw.headers["content-type"], identity.headers.get("content-type"));
    assert.equal(identity.headers.get("content-encoding"), null);
    assert.deepEqual(gunzipSync(raw.body), Buffer.from(await identity.arrayBuffer()));
    assert.ok(raw.body.length < Number(identity.headers.get("content-length")));
  }
});

test("side-by-side ports use independent cookie names without replacing stable authentication", async () => {
  const f = await fixture();
  const stable = new Authentication({ dir: f.config, token });
  const ux = new Authentication({ dir: f.config, token: "different-ux-token-for-tests-0123456789", cookieName: "pr_ux_session" });
  const req = { headers: { host: "host.example:10001", "x-forwarded-proto": "https" } };
  const stableCookie = stable.cookie(req).split(";")[0];
  const uxCookie = ux.cookie(req).split(";")[0];
  assert.match(stableCookie, /^pr_session=/);
  assert.match(uxCookie, /^pr_ux_session=/);
  const both = { headers: { cookie: stableCookie + "; " + uxCookie } };
  assert.equal(stable.isAuthorized(both), true);
  assert.equal(ux.isAuthorized(both), true);
  assert.equal(stable.isAuthorized({ headers: { cookie: uxCookie } }), false);
  assert.equal(ux.isAuthorized({ headers: { cookie: stableCookie } }), false);
  assert.throws(() => new Authentication({ dir: f.config, token, cookieName: "bad; cookie" }), /Invalid PWA cookie name/);
});

test('thinking deltas and completed tool calls reconstruct structured live content',()=>{
  const runner=new PiRunner({});
  const send=assistantMessageEvent=>runner.consume(Buffer.from(JSON.stringify({type:'message_update',assistantMessageEvent})+'\n'));
  send({type:'thinking_start',contentIndex:0});send({type:'thinking_delta',contentIndex:0,delta:'reason'});send({type:'thinking_end',contentIndex:0,content:'final reason'});
  send({type:'toolcall_end',contentIndex:1,toolCall:{type:'toolCall',id:'tool1',name:'bash',arguments:{command:'true'}}});
  assert.equal(runner.liveMessage.content[0].thinking,'final reason');assert.equal(runner.liveMessage.content[1].name,'bash');
  runner.consume(Buffer.from(JSON.stringify({type:'tool_execution_start',toolCallId:'tool1',toolName:'bash'})+'\n'));
  assert.equal(runner.tools.get('tool1').status,'运行中');
  runner.consume(Buffer.from(JSON.stringify({type:'tool_execution_end',toolCallId:'tool1',toolName:'bash',isError:true})+'\n'));
  assert.equal(runner.tools.get('tool1').status,'失败');
});

test('RPC identity changes reject stale state instead of writing to a new session',async()=>{
 const runner=new PiRunner({id:'original-session'});
 runner.child={stdin:{writable:true,write(line,done){const command=JSON.parse(line);queueMicrotask(()=>runner.consume(Buffer.from(JSON.stringify({type:'response',id:command.id,success:true,data:{sessionId:'switched-session'}})+'\n')));done?.();}}};
 await assert.rejects(()=>runner.request('get_state'),/session_identity_changed/);runner.stopWithError(new Error('finished'));
});
