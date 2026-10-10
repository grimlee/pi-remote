import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { discoverSessions, publicSession, PiRunner } from "./registry.mjs";
import { Authentication, CommandLedger, safeOrigin, readJson, stateDir } from "./security.mjs";

import { historyPage } from "./history.mjs";
import { validateImages, MAX_IMAGE_REQUEST } from "./images.mjs";
import { OwnedSessions, publicModel, validateControl, invalid } from "./control.mjs";
const root = path.dirname(fileURLToPath(import.meta.url));
const files = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/recover", ["sw-reset.html", "text/html; charset=utf-8"]],
  ["/sw-reset.js", ["sw-reset.js", "text/javascript; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/recovery.js", ["recovery.js", "text/javascript; charset=utf-8"]],
  ["/attachments.js", ["attachments.js", "text/javascript; charset=utf-8"]],
  ["/transcript.js", ["transcript.js", "text/javascript; charset=utf-8"]],
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
  const auth = new Authentication({ dir, ...(options.cookieName?{cookieName:options.cookieName}:{}), ...(options.token ? { token: options.token } : {}) });
  const ledger = new CommandLedger(dir);
  // Only explicitly configured PWA-owned storage is opened. Native Pi sessions
  // are never the implicit default for this branch.
  const sessionRoot = options.sessionDir || process.env.PI_CODING_AGENT_SESSION_DIR || path.join(dir,'sessions');
  const workspacePaths=options.workspaces || (process.env.PI_REMOTE_PWA_WORKSPACES ? JSON.parse(process.env.PI_REMOTE_PWA_WORKSPACES) : undefined);
  const owned=new OwnedSessions(dir,sessionRoot,workspacePaths);
  let creationLock=false;
  const executable = options.executable || process.env.PI_REMOTE_PWA_PI_COMMAND || "pi";
  const runners = new Map();
  let records = new Map();
  let stopped = false;

  async function refreshSessions() {
    await owned.ready;
    const discovered=await discoverSessions(sessionRoot);
    const found=new Map(discovered.map(s=>[s.id,{...s,generation:owned.items.get(s.id)?.generation || s.generation}]));
    for(const [id,s] of owned.items) if(!found.has(id)) found.set(id,s);
    const list=[...found.values()].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
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
      if(runner.busy || runner.uiRequests.size || runner.pending.size)throw invalid('session_generation_changed',409);
      runner.stop();
      runners.delete(id);
      runner = null;
    }
    if (!runner || runner.dead) {
      if (runners.size >= 8) {
        const idle = [...runners.entries()].find(([, value]) => !value.busy && !value.uiRequests.size && !value.pending.size);
        if (!idle) throw Object.assign(new Error("Too many active sessions"), { status: 429 });
        idle[1].stop();
        runners.delete(idle[0]);
      }
      runner = new PiRunner(session, {
        executable, sessionDir:owned.root, extraArgs:options.piArgs,
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
    if (method === "GET" && (files.has(pathname) || /^\/vendor\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?$/.test(pathname))) {
      const [file, mime] = files.get(pathname) || [pathname.slice(1), pathname.endsWith('.js') ? 'text/javascript; charset=utf-8' : pathname.endsWith('.css') ? 'text/css; charset=utf-8' : pathname.endsWith('.woff2') ? 'font/woff2' : pathname.endsWith('.woff') ? 'font/woff' : 'application/octet-stream'];
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
    if(pathname==='/api/workspaces' && method==='GET') {
      try {await owned.ready;json(res,200,{workspaces:owned.workspaces.map(({cwd,...w})=>w)});}catch{error(res,503,'workspaces_unavailable');}return;
    }
    if(pathname==='/api/sessions' && method==='POST') {
      let runner;
      try {
        await owned.ready;
        const body=await readJson(req,4096);
        if(!/^[\w-]{10,100}$/.test(body?.commandId||''))throw invalid('invalid_command_id');
        const workspace=owned.workspaces.find(w=>w.id===body.workspaceId);if(!workspace)throw invalid('invalid_workspace');
        const hash=createHash('sha256').update('create\n'+workspace.id).digest('hex');
        const prior=ledger.get(body.commandId);
        if(prior) {if(prior.hash!==hash)throw invalid('command_id_conflict',409);json(res,200,{status:prior.status,deduplicated:true,session:prior.result});return;}
        if(creationLock || runners.size>=8 || owned.items.size>=500)throw invalid('session_limit',429);
        creationLock=true;
        const receipt={id:body.commandId,sessionId:'new',hash,status:'unknown',at:Date.now()};ledger.save(receipt);
        try {
          runner=new PiRunner({cwd:workspace.cwd},{executable,sessionDir:owned.root,extraArgs:options.piArgs});await runner.start();
          const result=await runner.request('new_session',{},30000);if(result?.cancelled)throw invalid('creation_cancelled',409);
          await runner.request('set_session_name',{name:'新会话'});
          const state=await runner.request('get_state');
          if(!/^[\w-]{8,128}$/.test(state?.sessionId||'') || !owned.contains(state.sessionFile))throw invalid('invalid_created_session',503);
          const session={id:state.sessionId,file:state.sessionFile,cwd:workspace.cwd,name:state.sessionName||'新会话',model:state.model?state.model.provider+'/'+state.model.id:null,generation:Date.now(),startedAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
          await owned.save(session);runner.session=session;runner.ready=Promise.resolve();
          runner.onClosed=closed=>{if(runners.get(session.id)===closed)runners.delete(session.id);};runners.set(session.id,runner);
          records.set(session.id,session);receipt.sessionId=session.id;receipt.status='accepted';receipt.result=publicSession(session);ledger.save(receipt);
          json(res,201,{status:'accepted',session:receipt.result});
        }catch(e){runner?.stop();if(e.code==='creation_cancelled'){receipt.status='rejected';ledger.save(receipt);throw e;}json(res,503,{status:'unknown',commandId:body.commandId});}
        finally {creationLock=false;}
      }catch(e){error(res,e.status||503,e.code||'creation_unavailable');}
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
      json(res, 200, { commandId: receipt.id, sessionId: receipt.sessionId, status: receipt.status, ...(receipt.result ? {result:receipt.result}: {}) });
      return;
    }

    const match = /^\/api\/sessions\/([^/]+)\/(state|events|commands|controls)$/.exec(pathname);
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
        const limit=url.searchParams.has('limit')?Number(url.searchParams.get('limit')):160;
        const before=url.searchParams.has('before')?Number(url.searchParams.get('before')):undefined;
        const page=historyPage(snapshot.messages,{limit,before,revision:url.searchParams.get('revision')||undefined});
        const value={...snapshot,...page};
        const etag='"'+createHash('sha256').update(JSON.stringify(value)).digest('hex')+'"';
        if(req.headers['if-none-match']===etag){res.writeHead(304,{'ETag':etag,'Cache-Control':'no-store'});res.end();return;}
        json(res, 200, value, {ETag:etag});
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
      if(action==='controls' && method==='GET') {
        const models=await runner.request('get_available_models');
        const levels=await runner.request('get_available_thinking_levels');
        const commands=await runner.request('get_commands');
        const stats=await runner.request('get_session_stats');
        const {sessionFile,...safeStats}=stats||{};
        json(res,200,{models:(models?.models||[]).map(publicModel),levels:levels?.levels||[],commands:(commands?.commands||[]).map(c=>({name:c.name,description:c.description,source:c.source})),stats:safeStats});return;
      }
      if (action === "commands" && method === "POST") {
        const body = await readJson(req, MAX_IMAGE_REQUEST);
        if (!body || !["prompt", "abort", "set_session_name", "set_model", "set_thinking_level", "extension_ui_response"].includes(body.type)) {
          error(res, 400, "unsupported_command"); return;
        }
        if (body.generation!==undefined && body.generation!==runner.session.generation) {error(res,409,'stale_session_generation');return;}
        if(body.type==='extension_ui_response') {
          if(body.generation!==runner.session.generation)throw invalid('stale_session_generation',409);
          if(!/^[\w-]{10,100}$/.test(body.commandId||'')||typeof body.requestId!=='string')throw invalid('invalid_ui_response');
          const values={id:body.requestId,...(body.cancelled===true?{cancelled:true}:typeof body.confirmed==='boolean'?{confirmed:body.confirmed}:{value:body.value})};
          const hash=createHash('sha256').update(JSON.stringify([id,runner.session.generation,'ui',values])).digest('hex');
          const prior=ledger.get(body.commandId);if(prior){if(prior.hash!==hash||prior.sessionId!==id)throw invalid('command_id_conflict',409);json(res,200,{status:prior.status,deduplicated:true});return;}
          // Validate without consuming before recording, including stale/expired requests.
          const request=runner.uiRequests.get(body.requestId);if(!request || (request.expiresAt&&request.expiresAt<=Date.now()))throw invalid('request_expired',409);
          if(!values.cancelled && (request.method==='confirm'?typeof values.confirmed!=='boolean':typeof values.value!=='string'||values.value.length>20000||(request.method==='select'&&!request.options?.includes(values.value))))throw invalid('invalid_ui_value');
          const receipt={id:body.commandId,sessionId:id,hash,status:'unknown',at:Date.now()};ledger.save(receipt);
          try{await runner.answerUI(values);receipt.status='accepted';ledger.save(receipt);json(res,202,{status:'accepted'});}catch(e){if(e.code)throw e;json(res,503,{status:'unknown'});}return;
        }
        if(!['prompt','abort'].includes(body.type)) {
          if(body.generation!==runner.session.generation)throw invalid('stale_session_generation',409);
          const values=validateControl(body);
          const hash=createHash('sha256').update(JSON.stringify([id,runner.session.generation,body.type,values])).digest('hex');
          const prior=ledger.get(body.commandId);
          if(prior){if(prior.hash!==hash||prior.sessionId!==id)throw invalid('command_id_conflict',409);json(res,200,{status:prior.status,deduplicated:true,commandId:body.commandId});return;}
          const state=await runner.request('get_state');if(state.isStreaming||state.isCompacting||state.isRetrying)throw invalid('session_busy',409);
          if(body.type==='set_model') {const models=await runner.request('get_available_models');if(!models.models?.some(m=>m.provider===values.provider&&m.id===values.modelId))throw invalid('unsupported_model');}
          if(body.type==='set_thinking_level'){const levels=await runner.request('get_available_thinking_levels');if(!levels.levels?.includes(values.level))throw invalid('unsupported_thinking_level');}
          const raced=ledger.get(body.commandId);if(raced){if(raced.hash!==hash||raced.sessionId!==id)throw invalid('command_id_conflict',409);json(res,200,{status:raced.status,deduplicated:true,commandId:body.commandId});return;}
          const receipt={id:body.commandId,sessionId:id,hash,status:'unknown',at:Date.now()};ledger.save(receipt);
          try{await runner.request(body.type,values);receipt.status='accepted';ledger.save(receipt);
            if(body.type==='set_session_name'){runner.session.name=values.name;runner.session.updatedAt=new Date().toISOString();await owned.save(runner.session);}
            if(body.type==='set_model'){runner.session.model=values.provider+'/'+values.modelId;await owned.save(runner.session);}
            if(body.type==='set_thinking_level'){runner.session.thinkingLevel=values.level;await owned.save(runner.session);}
            json(res,202,{status:'accepted',commandId:body.commandId});
          }catch(e){if(e.rpcRejected){receipt.status='rejected';ledger.save(receipt);error(res,422,'rpc_rejected');}else json(res,503,{status:'unknown',commandId:body.commandId});}return;
        }
        if (body.type === "abort") {
          await runner.request("get_state");
          await runner.request("abort", {});
          json(res, 200, { status: "accepted" });
          return;
        }
        if (typeof body.message !== "string" || (!body.message.trim() && !body.images?.length) || body.message.length > 50000
          || typeof body.commandId !== "string" || !/^[\w-]{10,100}$/.test(body.commandId)) {
          error(res, 400, "invalid_prompt"); return;
        }
        const images=validateImages(body.images);
        const hash = createHash("sha256").update(JSON.stringify([id,body.message,images])).digest("hex");
        const prior = ledger.get(body.commandId);
        if (prior) {
          if (prior.hash !== hash || prior.sessionId !== id) {
            error(res, 409, "command_id_conflict"); return;
          }
          json(res, 200, { status: prior.status, deduplicated: true, commandId: body.commandId });
          return;
        }
        const promptState=await runner.request('get_state');
        if(images.length && !promptState.model?.input?.includes('image'))throw invalid('model_does_not_support_images');
        if(body.message.trimStart().startsWith('/')) {
          const name=body.message.trimStart().split(/\s/)[0].slice(1);
          const commands=await runner.request('get_commands');if(!commands?.commands?.some(c=>c.name===name))throw invalid('unsupported_slash_command');
          const raced=ledger.get(body.commandId);if(raced){if(raced.hash!==hash||raced.sessionId!==id)throw invalid('command_id_conflict',409);json(res,200,{status:raced.status,deduplicated:true,commandId:body.commandId});return;}
        }
        const raced=ledger.get(body.commandId);if(raced){if(raced.hash!==hash||raced.sessionId!==id)throw invalid('command_id_conflict',409);json(res,200,{status:raced.status,deduplicated:true,commandId:body.commandId});return;}
        const receipt = { id: body.commandId, sessionId: id, hash, status: "unknown", at: Date.now() };
        ledger.save(receipt);
        try {
          await runner.request("prompt", { message: body.message, ...(images.length?{images}: {}) }, 30000);
          receipt.status = "accepted";
          ledger.save(receipt);
          json(res, 202, { status: "accepted", commandId: body.commandId });
        } catch (e) {
          if(e.rpcRejected){receipt.status="rejected";ledger.save(receipt);error(res,422,"rpc_rejected");return;}
          // Unknown is intentionally not re-dispatched automatically: at-most-once over double execution.
          json(res, 503, { status: "unknown", commandId: body.commandId });
        }
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
    for (const runner of runners.values()) runner.stop();
    server.closeIdleConnections();
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
    console.log("Read the PWA login token privately from " + path.join(stateDir(), "access-token"));
    console.log("The native Tailcat Quick Connect launcher remains npm start.");
  });
  const stop = () => { app.close().then(() => process.exit(0)); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
