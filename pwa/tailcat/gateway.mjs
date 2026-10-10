import { createServer, connect } from 'node:net';
import { chmodSync, existsSync, unlinkSync, lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PiService, fault } from '../service.mjs';
import { DeviceAuthority, validSignature } from './authorization.mjs';
import { VERSION, Framer, frame, proof, MAX_RESULT, CHUNK, MAX_PENDING } from './protocol.mjs';

// This adapter never accepts HTTP, shell commands, arbitrary RPC or proxy routes.
export async function prepareAdminSocket(stateDir) {
  const file = path.join(stateDir, 'admin.sock');
  if (!existsSync(file)) return;
  const entry = lstatSync(file);
  if (!entry.isSocket() || entry.uid !== process.getuid()) throw new Error('Refuse to replace non-owned admin socket');
  const active = await new Promise((resolve, reject) => {
    const socket = connect(file);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', error => { if (['ECONNREFUSED','ENOENT'].includes(error.code)) resolve(false); else reject(error); });
    socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('Admin socket liveness unknown')); });
  });
  if (active) throw new Error('Admin socket already active; refuse second gateway');
  if (existsSync(file)) {
    const current = lstatSync(file);
    if (!current.isSocket() || current.ino !== entry.ino || current.uid !== entry.uid) throw new Error('Admin socket changed during probe');
    unlinkSync(file);
  }
}
export function createTailcatGateway(options) {
  if (!options?.stateDir || !options?.sessionDir) throw new Error('Isolated stateDir and sessionDir are required');
  const authority = options.authority || new DeviceAuthority(options.stateDir);
  if (!options.service && (!options.executable || !path.isAbsolute(options.executable))) throw new Error('Explicit absolute Pi executable required; no system pi fallback');
  const service = options.service || new PiService({...options, strictWorkspaces: true});
  const peers = new Set();
  const server = createServer(socket => {
    if (peers.size >= 32) { socket.destroy(); return; }
    peers.add(socket);
    const reader = new Framer();
    const hello = authority.hello();
    const inflight = new Map();
    const subscriptions = new Map();
    const seen = new Set();
    let device = null, seq = 0, queued = 0, responseBytes = 0, lease = Date.now();
    let writeTail = Promise.resolve();
    socket.setTimeout(60000, () => socket.destroy());
    const active = () => !socket.destroyed && (!device || !!authority.active(device.id, device.grant.origin));
    function send(value) {
      let bytes;
      try { bytes = frame(value); } catch { socket.destroy(); return Promise.reject(fault(413, 'frame_too_large')); }
      queued += bytes.length;
      if (queued > 2 * 1024 * 1024 || !active()) { socket.destroy(); return Promise.reject(fault(503, 'connection_closed')); }
      const task = writeTail.then(() => new Promise((resolve, reject) => {
        if (!active()) { socket.destroy(); reject(fault(401, 'not_authenticated')); return; }
        socket.write(bytes, error => error ? reject(error) : resolve());
      }));
      writeTail = task.catch(() => socket.destroy()).finally(() => { queued -= bytes.length; });
      return task;
    }
    async function result(id, value, cancelled) {
      if (cancelled()) return;
      const bytes = Buffer.from(JSON.stringify(value));
      if (bytes.length > MAX_RESULT) throw fault(413, 'result_too_large');
      responseBytes += bytes.length;
      if (responseBytes > MAX_RESULT) { responseBytes -= bytes.length; throw fault(429, 'backpressure_limit'); }
      try {
      await send({v: VERSION, type: 'result.start', id, bytes: bytes.length});
      for (let i = 0, index = 0; i < bytes.length; i += CHUNK, index++) {
        if (cancelled()) return;
        await send({v: VERSION, type: 'result.chunk', id, index, data: bytes.subarray(i, i + CHUNK).toString('base64url')});
      }
      if (!cancelled()) await send({v: VERSION, type: 'result.end', id});
      } finally { responseBytes -= bytes.length; }
    }
    const timeout = setInterval(() => { if (!active() || Date.now() - lease > (device ? 45000 : 15000)) socket.destroy(); }, 5000);
    socket.on('error', () => {});
    socket.on('close', () => {
      clearInterval(timeout); peers.delete(socket);
      for (const unsubscribe of subscriptions.values()) unsubscribe();
      subscriptions.clear();
      for (const task of inflight.values()) task.cancelled = true;
      // Pi processes and durable receipts intentionally outlive the transport.
    });
    async function dispatch(request) {
      const args = request.args;
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw fault(400, 'invalid_args');
      switch (request.op) {
        case 'ping': return {ok: true};
        case 'sessions.list': return service.list(args);
        case 'session.state': {
          const snapshot = await service.snapshot(args.sessionId);
          const total = snapshot.messages.length;
          const limit = args.limit ?? 160;
          const offset = args.offset ?? Math.max(0, total - limit);
          if (!Number.isInteger(limit) || limit < 1 || limit > 160 || !Number.isSafeInteger(offset) || offset < 0 || offset > total) throw fault(400, 'invalid_page');
          if (args.cursor !== undefined && args.cursor !== snapshot.cursor) throw fault(409, 'state_changed');
          const {sessionFile, ...state} = snapshot.state;
          return {...snapshot, state, messages: snapshot.messages.slice(offset, offset + limit), history: {offset, total, next: offset + limit < total ? offset + limit : null}};
        }
        case 'models.list': return service.models(args.sessionId);
        case 'command.receipt': return service.receipt(args.commandId);
        case 'command.dispatch': return service.command(args.sessionId || 'new_session', args.command);
        case 'session.subscribe': {
          if (subscriptions.size >= 4 || !Number.isSafeInteger(args.since) || args.since < 0) throw fault(400, 'invalid_subscription');
          const runner = await service.runnerFor(args.sessionId);
          const subscription = request.id;
          const unsubscribe = runner.subscribe(event => {
            // Large event records are chunked under the same response budget.
            void result('event:' + subscription + ':' + event.id, {subscription, event}, () => socket.destroyed).catch(() => socket.destroy());
          }, args.since);
          subscriptions.set(subscription, unsubscribe);
          return {subscription};
        }
        case 'session.unsubscribe': {
          subscriptions.get(args.subscription)?.(); subscriptions.delete(args.subscription); return {ok: true};
        }
        case 'request.cancel': {
          const task = inflight.get(args.id);
          if (task) {
            task.cancelled = true;
            await send({v: 1, type: 'result.error', id: args.id, status: 499, error: 'request_cancelled'});
          }
          return {ok: true};
        }
        default: throw fault(400, 'unsupported_operation');
      }
    }
    function accept(message) {
      const {signature, ...value} = message;
      if (!device) {
        if (message.type === 'pair') {
          if (!validSignature(proof('pair', hello, message.deviceId, value), signature, message.key)) throw fault(401, 'auth_failed');
          authority.pair(message);
          device = authority.active(message.deviceId, message.origin);
        } else if (message.type === 'auth') {
          const candidate = authority.active(message.deviceId, message.origin);
          if (!candidate || !validSignature(proof('auth', hello, message.deviceId, value), signature, candidate.grant.key)) throw fault(401, 'auth_failed');
          device = candidate;
        } else throw fault(401, 'auth_failed');
        lease = Date.now();
        socket.browserDevice = device.id;
        void send(authority.sign({v: 1, type: 'ready', connection: hello.connection, grant: device.grant})).catch(() => socket.destroy());
        return;
      }
      if (!active() || message.type !== 'request' || message.seq !== seq + 1 || typeof message.id !== 'string' || !/^[\w-]{10,100}$/.test(message.id) || seen.has(message.id) || !validSignature(proof('request', hello, device.id, value), signature, device.grant.key)) throw fault(401, 'auth_failed');
      seq = message.seq; lease = Date.now(); seen.add(message.id);
      if (seen.size > 4096) throw fault(429, 'connection_rotation_required');
      if (inflight.size >= MAX_PENDING) throw fault(429, 'too_many_requests');
      const task = {cancelled: false}; inflight.set(message.id, task);
      void dispatch(message).then(value => result(message.id, value, () => task.cancelled || socket.destroyed)).catch(e => {
        if (!task.cancelled && !socket.destroyed) return send({v: 1, type: 'result.error', id: message.id, status: e.status || 503, error: e.status ? e.code : 'backend_unavailable'});
      }).catch(() => socket.destroy()).finally(() => inflight.delete(message.id));
    }
    socket.on('data', bytes => {
      try {
        const messages = reader.push(bytes);
        if (messages.length > 32) throw new Error('batch_limit');
        for (const message of messages) accept(message);
      } catch { socket.destroy(); }
    });
    void send(hello).catch(() => socket.destroy());
  });
  server.on('error', () => {});
  let admin;
  function listenAdmin() {
    const file = path.join(options.stateDir, 'admin.sock');
    if (existsSync(file)) throw new Error('Admin socket already exists; refuse to replace it');
    admin = createServer(socket => {
      const reader = new Framer(); let handled = false;
      socket.setTimeout(5000, () => socket.destroy()); socket.on('error', () => {});
      socket.on('data', bytes => {
        try {
          const batch = reader.push(bytes);
          if (!batch.length) return;
          if (handled || batch.length !== 1) throw new Error('invalid_admin_request');
          handled = true;
          const {op, args} = batch[0]; let value;
          if (op === 'pair.mint') value = authority.mint(args);
          else if (op === 'device.revoke') {
            authority.revoke(args.deviceId);
            // Immediate stream/socket revocation, not just future login checks.
            for (const peer of peers) if (peer.browserDevice === args.deviceId) peer.destroy();
            value = {ok: true};
          } else if (op === 'devices.list') value = {devices: authority.state.devices.map(({id, name, revokedAt}) => ({id, name, revokedAt}))};
          else throw new Error('unsupported_admin_operation');
          socket.end(frame({v: 1, value}));
        } catch { socket.end(frame({v: 1, error: 'admin_request_failed'})); }
      });
    });
    admin.listen(file, () => chmodSync(file, 0o600));
    return file;
  }
  async function close() {
    for (const socket of peers) socket.destroy();
    service.close();
    if (admin) { await new Promise(resolve => admin.close(resolve)); const file = path.join(options.stateDir, 'admin.sock'); if (existsSync(file)) unlinkSync(file); }
    await new Promise(resolve => server.close(resolve));
  }
  return {server, authority, service, listenAdmin, close};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stateDir = process.env.PI_REMOTE_BROWSER_STATE_DIR;
  const sessionDir = process.env.PI_REMOTE_BROWSER_SESSION_DIR;
  if (!stateDir || !sessionDir || !path.isAbsolute(sessionDir)) throw new Error('Explicit isolated browser state/session directories required');
  const port = Number(process.env.PI_REMOTE_BROWSER_PORT || 17987);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid isolated gateway port');
  await prepareAdminSocket(stateDir);
  const app = createTailcatGateway({stateDir, sessionDir, executable: process.env.PI_REMOTE_BROWSER_PI_COMMAND, workspaces: process.env.PI_REMOTE_BROWSER_WORKSPACES ? JSON.parse(process.env.PI_REMOTE_BROWSER_WORKSPACES) : []});
  app.server.listen(port, '127.0.0.1', () => { app.listenAdmin(); console.log('Authenticated browser gateway listening on loopback port ' + port); });
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => void app.close().then(() => process.exit(0)));
}
