import { VERSION, Framer, frame, canonical, proof, encoder, b64, unb64, MAX_RESULT, MAX_PENDING } from './protocol.mjs';
import { loadDevice, saveDevice, verifySigned, signValue } from './identity.mjs';

const fail = (status, code) => Object.assign(new Error(code), {status});
let identity, config, conn, hello, connectPromise, suspended = false, ready = false;
let seq = 0, epoch = 0, timer, pingTimer, retries = 0, writeTail = Promise.resolve(), receivedBytes = 0;
const cancelled = new Set();
const pending = new Map(), assembly = new Map(), subscriptions = new Map(), acknowledgements = new Map();
const post = value => self.postMessage(value);

async function boot() {
  const started = performance.now();
  await import('./wasm_exec.js');
  if (!globalThis.Go || !globalThis.WebAssembly || !globalThis.DecompressionStream) throw fail(400, 'required_browser_apis_unavailable');
  const response = await fetch('./main.wasm.gz');
  if (!response.ok || !response.body) throw fail(503, 'wasm_download_failed');
  const go = new Go();
  const registered = new Promise(resolve => { globalThis.onTailcatReady = resolve; });
  const stream = response.body.pipeThrough(new DecompressionStream('gzip'));
  const {instance} = await WebAssembly.instantiateStreaming(new Response(stream, {headers: {'Content-Type': 'application/wasm'}}), go.importObject);
  void go.run(instance).catch(() => drop(fail(503, 'wasm_runtime_failed')));
  await registered;
  ({identity, config} = await loadDevice());
  post({type: 'boot', startupMs: Math.round(performance.now() - started), configured: !!config});
}
const booted = boot();
booted.catch(() => post({type: 'fatal', error: '无法初始化 WASM 或安全设备密钥存储', status: 503}));
function schedule() {
  clearTimeout(timer);
  if (!config || suspended) return;
  timer = setTimeout(() => { void connect().catch(() => schedule()); }, Math.min(1000 * 2 ** Math.min(retries++, 4), 15000) + Math.random() * 500);
}
function drop(error = fail(503, 'connection_lost'), reconnect = true, notify = true) {
  epoch++; ready = false;
  clearInterval(pingTimer); clearTimeout(timer);
  try { conn?.close(); } catch {}
  conn = null; hello = null; writeTail = Promise.resolve();
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); }
  pending.clear(); assembly.clear(); receivedBytes = 0; acknowledgements.clear();
  if (notify) post({type: 'disconnected'});
  if (reconnect) schedule();
}
async function write(value, context = 'request') {
  const activeEpoch = epoch;
  const task = writeTail.then(async () => {
    if (!conn || activeEpoch !== epoch) throw fail(503, 'connection_lost');
    if (context === 'request' && cancelled.delete(value.id)) throw fail(499, 'request_cancelled');
    if (context === 'request') value = {...value, seq: ++seq};
    const candidate = conn;
    const signed = await signValue(identity, proof(context, hello, identity.id, value));
    if (activeEpoch !== epoch || candidate !== conn) throw fail(503, "connection_lost");
    await candidate.write(frame({...value, signature: signed.signature}));
  });
  writeTail = task.catch(() => {});
  return task;
}
function waitFor(id, timeout = 45000) {
  if (pending.size >= MAX_PENDING) throw fail(429, 'too_many_requests');
  let entry;
  const promise = new Promise((resolve, reject) => {
    entry = {resolve, reject, timer: setTimeout(() => {
      pending.delete(id);
      // Drop partial chunks and uncertain requests. Reconnect only reads state;
      // it never queues a mutation for a second send.
      drop(fail(503, 'request_timeout'));
      reject(fail(503, 'request_timeout'));
    }, timeout)};
    pending.set(id, entry);
  });
  return promise;
}
function complete(id, value, error) {
  const entry = pending.get(id);
  if (!entry) return;
  clearTimeout(entry.timer); pending.delete(id);
  if (error) entry.reject(error); else entry.resolve(value);
}
function receive(message) {
  if (message.type === 'result.error') {
    const partial = assembly.get(message.id);
    if (partial) { receivedBytes -= partial.bytes.length; assembly.delete(message.id); }
    cancelled.delete(message.id);
    const error = fail(message.status || 503, message.error || 'request_failed');
    error.definitive = [400, 403, 404, 413, 429].includes(message.status);
    complete(message.id, null, error); return;
  }
  if (message.type === 'result.start') {
    if (!Number.isInteger(message.bytes) || message.bytes < 0 || message.bytes > MAX_RESULT || assembly.has(message.id) || assembly.size >= 32 || receivedBytes + message.bytes > MAX_RESULT) throw fail(413, 'response_budget_exceeded');
    if (!pending.has(message.id) && !message.id?.startsWith('event:')) throw fail(400, 'unexpected_response');
    receivedBytes += message.bytes;
    assembly.set(message.id, {bytes: new Uint8Array(message.bytes), offset: 0, index: 0}); return;
  }
  const item = assembly.get(message.id);
  if (!item) throw fail(400, 'unexpected_frame');
  if (message.type === 'result.chunk') {
    const bytes = unb64(message.data);
    if (message.index !== item.index++ || item.offset + bytes.length > item.bytes.length) throw fail(400, 'invalid_chunk');
    item.bytes.set(bytes, item.offset); item.offset += bytes.length; return;
  }
  if (message.type !== 'result.end' || item.offset !== item.bytes.length) throw fail(400, 'incomplete_result');
  const value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(item.bytes));
  assembly.delete(message.id); receivedBytes -= item.bytes.length;
  if (message.id.startsWith('event:')) {
    if (acknowledgements.size >= 8 || [...acknowledgements.values()].reduce((a, b) => a + b, 0) + item.bytes.length > 1024 * 1024) throw fail(429, 'ui_backpressure');
    const subscription = subscriptions.get(value.subscription);
    if (subscription) {
      subscription.since = value.event.id;
      acknowledgements.set(message.id, item.bytes.length);
      post({type: 'event', id: message.id, subscription: value.subscription, event: value.event});
    }
  } else complete(message.id, value);
}
async function handshake(pairing) {
  const activeEpoch = epoch;
  const candidate = await tailcatDial({addr: config.address, port: config.port, derpMapURL: 'https://tailcat.dev/derpmap.json'});
  if (activeEpoch !== epoch || suspended) { candidate.close(); throw fail(503, 'connection_cancelled'); }
  conn = candidate; seq = 0;
  const reader = new Framer();
  let greeted = false, authenticated = false;
  const authWait = waitFor('handshake', 20000);
  // Observe rejection immediately while asynchronous signature checks run.
  authWait.catch(() => {});
  void (async () => {
    try {
      while (activeEpoch === epoch && conn === candidate) {
        const bytes = await candidate.read();
        if (bytes === null) throw fail(503, 'connection_lost');
        for (const message of reader.push(bytes)) {
          if (!greeted) {
            if (message.type !== 'hello' || message.hostId !== config.host.id || canonical(message.key) !== canonical(config.host.key) || !await verifySigned(message, config.host.key)) throw fail(401, 'host_identity_mismatch');
            hello = message; greeted = true;
            const value = pairing ? {v: 1, type: 'pair', invitationId: pairing.id, secret: pairing.secret, origin: config.origin, deviceId: identity.id, key: identity.key, name: 'Browser device'} : {v: 1, type: 'auth', origin: config.origin, deviceId: identity.id};
            await write(value, pairing ? 'pair' : 'auth');
          } else if (!authenticated) {
            if (message.type !== 'ready' || message.connection !== hello.connection || !await verifySigned(message, config.host.key) || !await verifySigned(message.grant, config.host.key) || message.grant.deviceId !== identity.id || canonical(message.grant.key) !== canonical(identity.key) || message.grant.origin !== config.origin || message.grant.hostId !== config.host.id || message.grant.role !== 'owner') throw fail(401, 'invalid_host_grant');
            config.grant = message.grant;
            await saveDevice(identity, config);
            authenticated = true; complete('handshake', {ok: true});
          } else receive(message);
        }
      }
    } catch (e) { if (activeEpoch === epoch) drop(e); }
  })();
  await authWait;
  if (activeEpoch !== epoch) throw fail(503, 'connection_cancelled');
  ready = true; retries = 0;
  pingTimer = setInterval(() => { void request('ping', {}, undefined, 20000).then(() => post({type: 'pulse'})).catch(() => drop()); }, 15000);
  post({type: 'connected'});
  // Receipt reads are safe after reconnect; uncertain mutations are never sent
  // again. Keep IDs in the sealed IndexedDB record even if localStorage fails.
  void reconcilePending();
}
async function connect(pairing) {
  await booted;
  if (!config) throw fail(401, 'not_paired');
  if (suspended) throw fail(503, 'page_suspended');
  if (ready) return;
  if (connectPromise) return connectPromise;
  connectPromise = handshake(pairing).finally(() => { connectPromise = null; });
  return connectPromise;
}
async function request(op, args, id = crypto.randomUUID(), timeout) {
  // Reject oversized requests before reserving an uncertain mutation or dialing.
  try { frame({v: VERSION, type: 'request', id, seq: 999999, op, args, signature: 'x'.repeat(86)}); }
  catch { throw Object.assign(fail(413, 'request_too_large'), {definitive: true}); }
  if (cancelled.delete(id)) throw fail(499, "request_cancelled");
  try { await connect(); }
  catch (error) { error.definitive = true; throw error; } // This operation has not been sent.
  if (cancelled.delete(id)) throw fail(499, "request_cancelled");
  if (op === 'command.dispatch') {
    const commandId = args.command?.commandId;
    const items = config.pendingMutations || [];
    if (items.some(x => x.id !== commandId) && args.command?.type !== 'abort') throw fail(409, 'prior_operation_unconfirmed_check_receipt');
    if (!items.some(x => x.id === commandId)) {
      if (items.length >= 32) throw fail(429, 'pending_mutation_limit');
      config.pendingMutations = [...items, {id: commandId, sessionId: args.sessionId, type: args.command.type}];
      await saveDevice(identity, config);
    }
    if (cancelled.delete(id)) throw fail(499, 'request_cancelled');
  }
  const response = waitFor(id, timeout);
  response.catch(() => {});
  try { await write({v: VERSION, type: 'request', id, op, args}); }
  catch (e) { complete(id, null, e); }
  let value;
  try { value = await response; }
  catch (error) {
    if (op === 'command.dispatch' && error.definitive) {
      config.pendingMutations = (config.pendingMutations || []).filter(x => x.id !== args.command.commandId);
      await saveDevice(identity, config);
    }
    throw error;
  }
  if ((op === 'command.dispatch' || op === 'command.receipt') && value.status === 'accepted') {
    config.pendingMutations = (config.pendingMutations || []).filter(x => x.id !== value.commandId);
    await saveDevice(identity, config);
  }
  return value;
}
async function reconcilePending() {
  for (const pending of [...(config?.pendingMutations || [])]) {
    if (!ready) return;
    try { await request('command.receipt', {commandId: pending.id}); } catch { /* Read-only reconciliation; retain missing/unknown receipts. */ }
  }
}
async function pair(text, origin) {
  await booted;
  if (config?.grant) throw fail(409, 'already_paired_use_new_browser_profile');
  if (typeof text !== 'string' || text.length > 12000) throw fail(400, 'invalid_pairing_bundle');
  let bundle;
  try { bundle = JSON.parse(text); } catch { throw fail(400, 'invalid_pairing_bundle'); }
  if (bundle.v !== 1 || bundle.kind !== 'pi-remote-tailcat' || bundle.origin !== origin || !/^tc[A-Za-z0-9_-]{20,5000}$/.test(bundle.address) || !Number.isInteger(bundle.port) || bundle.port < 1024 || bundle.port > 65535 || bundle.invitation?.expiresAt <= Date.now() || !await verifySigned(bundle, bundle.host?.key)) throw fail(401, 'invalid_pairing_bundle');
  drop(fail(503, 'pairing_started'), false, false);
  config = {host: bundle.host, address: bundle.address, port: bundle.port, origin};
  // Save identity + encrypted host pin before consuming the one-time invitation;
  // a lost pairing reply can be recovered with a device proof, without replaying it.
  await saveDevice(identity, config);
  try { await connect(bundle.invitation); }
  catch { throw fail(503, 'pairing_response_unknown_reconnect_or_mint_new_invite'); }
  return {ok: true};
}
self.onmessage = event => {
  const message = event.data;
  if (message.type === 'ack') { acknowledgements.delete(message.id); return; }
  if (message.type === 'suspend') { suspended = true; drop(fail(503, 'page_suspended'), false, false); return; }
  if (message.type === 'cancel') {
    const id = message.id;
    cancelled.add(id);
    if (cancelled.size > 128) cancelled.delete(cancelled.values().next().value);
    if (pending.has(id)) { complete(id, null, fail(499, 'request_cancelled')); void request('request.cancel', {id}).catch(() => {}); }
    return;
  }
  const run = async () => {
    if (message.type === 'pair') return pair(message.text, message.origin);
    if (message.type === 'resume') { await booted; suspended = false; if (!config) return {configured: false}; if (message.force && ready) drop(fail(503, 'foreground_reconnect'), false, false); await connect(); return {configured: true}; }
    if (message.type === 'request') return request(message.op, message.args, message.id);
    if (message.type === 'subscribe') {
      subscriptions.set(message.id, {sessionId: message.sessionId, since: message.since});
      try { return await request('session.subscribe', {sessionId: message.sessionId, since: message.since}, message.id); }
      catch (e) { subscriptions.delete(message.id); throw e; }
    }
    if (message.type === 'unsubscribe') {
      subscriptions.delete(message.subscription);
      cancelled.add(message.subscription);
      if (cancelled.size > 128) cancelled.delete(cancelled.values().next().value);
      if (ready) await request('session.unsubscribe', {subscription: message.subscription});
      return {ok: true};
    }
    throw fail(400, 'unsupported_worker_message');
  };
  void run().then(value => post({type: 'reply', id: message.id, value})).catch(e => post({type: 'reply', id: message.id, error: e.message?.replace(/tc[A-Za-z0-9_-]{20,}/g, 'tc[REDACTED]'), status: e.status || 503, definitive: e.definitive === true}));
};
