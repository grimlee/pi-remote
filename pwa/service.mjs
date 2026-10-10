// Shared authoritative Pi RPC service for the private HTTPS and Tailcat adapters.
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, statSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { discoverSessions, publicSession, PiRunner, DEFAULT_SESSION_DIR } from './registry.mjs';
import { CommandLedger, stateDir } from './security.mjs';

export const fault = (status, code) => Object.assign(new Error(code), {status, code});
export class PiService {
  constructor(options = {}) {
    this.ledger = options.ledger || new CommandLedger(options.stateDir || stateDir());
    this.sessionRoot = options.sessionDir || DEFAULT_SESSION_DIR;
    this.executable = options.executable || process.env.PI_REMOTE_PWA_PI_COMMAND || 'pi';
    this.workspaces = options.workspaces || [];
    this.strictWorkspaces = options.strictWorkspaces === true;
    if (this.strictWorkspaces) {
      if (!path.isAbsolute(this.sessionRoot) || !Array.isArray(this.workspaces) || !this.workspaces.length) throw new Error('Explicit isolated session directory and workspace allowlist required');
      mkdirSync(this.sessionRoot, {recursive: true, mode: 0o700});
      this.sessionRoot = realpathSync(this.sessionRoot);
      for (const cwd of this.workspaces) if (!path.isAbsolute(cwd) || realpathSync(cwd) !== cwd || !statSync(cwd).isDirectory()) throw new Error('Workspace must be an existing canonical absolute directory');
    }
    this.runners = new Map();
    this.temporaryRunners = new Set();
    this.records = new Map();
    this.maxRunners = options.maxRunners || 8;
    this.closed = false;
  }
  async refreshSessions(limit = 10000) {
    if (this.closed) throw fault(503, 'service_closed');
    const discovered = await discoverSessions(this.sessionRoot, limit);
    const list = this.strictWorkspaces ? discovered.filter(s => this.allowedRecord(s)) : discovered;
    if (this.closed) throw fault(503, 'service_closed');
    this.records = new Map(list.map(s => [s.id, s]));
    return list;
  }
  allowedRecord(session) {
    try {
      const file = realpathSync(session.file);
      const relative = path.relative(this.sessionRoot, file);
      return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
        && this.workspaces.includes(session.cwd) && realpathSync(session.cwd) === session.cwd && statSync(session.cwd).isDirectory();
    } catch { return false; }
  }
  async runnerFor(id) {
    if (this.closed) throw fault(503, 'service_closed');
    if (!/^[\w-]{8,128}$/.test(id)) throw fault(400, 'invalid_session');
    let session = this.records.get(id);
    if (!session) { await this.refreshSessions(); session = this.records.get(id); }
    if (!session) throw fault(404, 'session_not_found');
    if (this.strictWorkspaces && !this.allowedRecord(session)) throw fault(403, 'workspace_not_allowed');
    let runner = this.runners.get(id);
    if (runner && runner.session.generation !== session.generation) {
      runner.stop(); this.runners.delete(id); runner = null;
    }
    if (!runner || runner.dead) {
      this.makeRoom();
      runner = new PiRunner(session, {
        executable: this.executable, sessionDir: this.sessionRoot, strictCwd: this.strictWorkspaces,
        onClosed: closed => { if (this.runners.get(id) === closed) this.runners.delete(id); }
      });
      this.runners.set(id, runner);
      runner.ready = runner.start();
    }
    await runner.ready;
    return runner;
  }
  makeRoom() {
    if (this.runners.size + this.temporaryRunners.size < this.maxRunners) return;
    const idle = [...this.runners.entries()].find(([, runner]) => !runner.busy && runner.pending.size === 0 && runner.listeners.size === 0);
    if (!idle) throw fault(429, 'too_many_sessions');
    idle[1].stop(); this.runners.delete(idle[0]);
  }
  async list({offset = 0, limit = 100} = {}) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw fault(400, 'invalid_page');
    const list = await this.refreshSessions();
    return {sessions: list.slice(offset, offset + limit).map(publicSession), next: offset + limit < list.length ? offset + limit : null, ...(this.strictWorkspaces ? {workspaces: this.workspaces} : {})};
  }
  async snapshot(id) { return (await this.runnerFor(id)).snapshot(); }
  receipt(id) {
    const item = this.ledger.get(id);
    if (!item) throw fault(404, 'command_not_found');
    return {commandId: item.id, sessionId: item.sessionId, status: item.status, ...(item.result ? {result: item.result} : {})};
  }
  async command(id, body) {
    if (!body || !['prompt', 'abort', 'rename', 'set_model', 'create'].includes(body.type)) throw fault(400, 'unsupported_command');
    if (typeof body.commandId !== 'string' || !/^[\w-]{10,100}$/.test(body.commandId)) throw fault(400, 'invalid_command_id');
    let values = {};
    let rpc = body.type;
    if (body.type === 'prompt') {
      if (typeof body.message !== 'string' || !body.message.trim() || body.message.length > 50000) throw fault(400, 'invalid_prompt');
      values = {message: body.message};
    } else if (['rename', 'create'].includes(body.type)) {
      if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 128) throw fault(400, 'invalid_name');
      values = {name: body.name.trim()}; rpc = 'set_session_name';
      if (body.type === 'create') {
        await this.refreshSessions();
        const allowed = new Set(this.strictWorkspaces ? this.workspaces : [...this.workspaces, ...[...this.records.values()].map(s => s.cwd)]);
        if (!allowed.has(body.cwd)) throw fault(403, 'workspace_not_allowed');
        try { if (!statSync(body.cwd).isDirectory() || (this.strictWorkspaces && realpathSync(body.cwd) !== body.cwd)) throw new Error(); }
        catch { throw fault(404, 'workspace_unavailable'); }
        values.cwd = body.cwd;
      }
    } else if (body.type === 'set_model') {
      if (![body.provider, body.modelId].every(x => typeof x === 'string' && /^[\w./:-]{1,128}$/.test(x))) throw fault(400, 'invalid_model');
      values = {provider: body.provider, modelId: body.modelId};
    }
    // Retain the existing prompt hash so HTTP/Tailcat share receipt semantics.
    const hash = createHash('sha256').update(body.type === 'prompt' ? id + '\n' + body.message : JSON.stringify([id, body.type, values])).digest('hex');
    const prior = this.ledger.get(body.commandId);
    if (prior) {
      if (prior.hash !== hash || prior.sessionId !== id) throw fault(409, 'command_id_conflict');
      return {...this.receipt(body.commandId), deduplicated: true};
    }
    let runner = body.type === 'create' ? null : await this.runnerFor(id);
    // There is no await between the final lookup and durable reservation.
    const raced = this.ledger.get(body.commandId);
    if (raced) {
      if (raced.hash !== hash || raced.sessionId !== id) throw fault(409, 'command_id_conflict');
      return {...this.receipt(body.commandId), deduplicated: true};
    }
    const receipt = {id: body.commandId, sessionId: id, hash, status: 'unknown', at: Date.now()};
    if (this.closed) throw fault(503, 'service_closed');
    if (body.type === 'create') this.makeRoom();
    this.ledger.save(receipt);
    try {
      if (body.type === 'create') {
        // Pi 1.x intentionally delays persisting a fresh empty session until an
        // assistant turn. Seed only its documented v3 header + name metadata;
        // all Agent state and execution remain owned by the existing RPC runner.
        const sessionId = randomUUID();
        const timestamp = new Date().toISOString();
        mkdirSync(this.sessionRoot, {recursive: true, mode: 0o700});
        const file = path.join(this.sessionRoot, 'browser-' + sessionId + '.jsonl');
        const fd = openSync(file, 'wx', 0o600);
        try {
          writeFileSync(fd, JSON.stringify({type: 'session', version: 3, id: sessionId, timestamp, cwd: values.cwd}) + '\n'
            + JSON.stringify({type: 'session_info', id: randomUUID().slice(0, 8), parentId: null, timestamp, name: values.name}) + '\n');
          fsyncSync(fd);
        } finally { closeSync(fd); }
        const dir = openSync(this.sessionRoot, 'r');
        try { fsyncSync(dir); } finally { closeSync(dir); }
        runner = new PiRunner({cwd: values.cwd, file}, {executable: this.executable, sessionDir: this.sessionRoot, strictCwd: this.strictWorkspaces});
        this.temporaryRunners.add(runner);
        await runner.start();
      }
      const {cwd, ...rpcValues} = values;
      await runner.request(rpc, rpcValues, 30000);
      if (body.type === 'create') {
        const state = await runner.request('get_state');
        receipt.result = {sessionId: state?.sessionId};
      }
      receipt.status = 'accepted'; this.ledger.save(receipt);
      if (body.type === 'rename' || body.type === 'create') await this.refreshSessions();
    } catch { /* Never redispatch an uncertain mutation, even after process restart. */ }
    finally { if (body.type === 'create') { runner?.stop(); this.temporaryRunners.delete(runner); } }
    return this.receipt(body.commandId);
  }
  async models(id) {
    const data = await (await this.runnerFor(id)).request('get_available_models');
    const models = Array.isArray(data) ? data : data?.models;
    return {models: (Array.isArray(models) ? models : []).slice(0, 1000).map(m => ({id: m.id, provider: m.provider, name: m.name, contextWindow: m.contextWindow, maxTokens: m.maxTokens}))};
  }
  close() {
    this.closed = true;
    for (const runner of [...this.runners.values(), ...this.temporaryRunners]) runner.stop();
    this.runners.clear(); this.temporaryRunners.clear();
  }
}
