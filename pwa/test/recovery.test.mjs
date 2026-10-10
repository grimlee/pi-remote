import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { RecoveryMemory, messageFingerprint } from '../public/recovery.js';

function storage() {
  const items = new Map();
  return { getItem: k => items.get(k) ?? null, setItem: (k, v) => items.set(k, v), removeItem: k => items.delete(k), items };
}
async function browser(saved = storage(), fetchHook) {
  const nodes = new Map();
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, {
      id, value: '', textContent: '', hidden: false, disabled: false, children: [], handlers: {},
      scrollHeight: 0, scrollTop: 0, clientHeight: 0,
      classList: { add() {}, remove() {} },
      addEventListener(type, fn) { this.handlers[type] = fn; },
      append(...items) { this.children.push(...items); },
      replaceChildren(...items) { this.children = items; },
    });
    return nodes.get(id);
  };
  const session = { id: 'browser-session-1234', name: 'Disposable test', cwd: '/tmp/test' };
  const streams = [];
  const calls = [];
  const window = { localStorage: saved, handlers: {}, addEventListener(k, fn) { this.handlers[k] = fn; } };
  const document = { hidden: false, handlers: {}, getElementById: element,
    createElement: () => element(Math.random()), createDocumentFragment: () => element(Math.random()),
    addEventListener(k, fn) { this.handlers[k] = fn; } };
  class EventSource {
    constructor(url) { this.url = url; this.handlers = {}; streams.push(this); }
    addEventListener(k, fn) { this.handlers[k] = fn; }
    close() { this.closed = true; }
  }
  const timers = new Map();
  const delays = new Map();
  let nextTimer = 0;
  const fetch = async (url, options) => {
    calls.push({ url, options });
    if (fetchHook) { const r = await fetchHook(url, options); if (r) return r; }
    const data = url === '/api/sessions' ? { sessions: [session] }
      : url.endsWith('/state') ? { messages: [], busy: false, cursor: 12 } : { authenticated: true };
    return { status: 200, ok: true, json: async () => data };
  };
  const context = vm.createContext({ document, window, navigator: {}, location: {}, EventSource, fetch,
    crypto: webcrypto, TextEncoder, RecoveryMemory, messageFingerprint, AbortController,
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, fn); delays.set(id, delay); return id; },
    clearTimeout(id) { timers.delete(id); delays.delete(id); } });
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  vm.runInContext(source.replace(/^import .*\n/, ''), context);
  await new Promise(resolve => setImmediate(resolve));
  return { context, nodes, element, streams, calls, window, document, timers, delays, session, saved };
}

test('browser reload restores the selected session and foreground/network replaces SSE', async () => {
  const saved = storage(); new RecoveryMemory(saved).selected('browser-session-1234');
  const b = await browser(saved);
  assert.equal(b.streams.length, 1);
  assert.match(b.streams[0].url, /browser-session-1234\/events/);
  await b.document.handlers.visibilitychange();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(b.streams[0].closed, true);
  assert.equal(b.streams.length, 2);
  await b.window.handlers.online();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(b.streams[1].closed, true);
  assert.equal(b.streams.length, 3);
  const source = b.streams.at(-1); source.onerror();
  assert.equal(source.closed, true);
  const retry = [...b.timers.values()].at(-1); retry();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(b.streams.length, 4);
  assert.equal(b.calls.filter(c => c.url.endsWith('/commands')).length, 0);
});

test('lost command response retains the same ID across a browser reload, without storing text', async () => {
  const saved = storage(); new RecoveryMemory(saved).selected('browser-session-1234');
  const lost = async (url) => {
    if (url.endsWith('/commands')) throw new Error('connection lost after acceptance');
    if (url.startsWith('/api/commands/')) return { status: 503, ok: false, json: async () => ({status:'unknown'}) };
  };
  const first = await browser(saved, lost);
  first.element('prompt').value = 'a private test instruction';
  await first.element('composer').handlers.submit({ preventDefault() {} });
  const command1 = JSON.parse(first.calls.find(c => c.url.endsWith('/commands')).options.body);
  assert.ok(new RecoveryMemory(saved).pending(first.session.id));
  assert.doesNotMatch(JSON.stringify([...saved.items]), /private test instruction/);
  const second = await browser(saved, lost);
  assert.equal(second.calls.filter(c => c.url.endsWith('/commands')).length, 0);
  second.element('prompt').value = 'a private test instruction';
  await second.element('composer').handlers.submit({ preventDefault() {} });
  const command2 = JSON.parse(second.calls.find(c => c.url.endsWith('/commands')).options.body);
  assert.equal(command2.commandId, command1.commandId);
});

test('recovered live assistant snapshot renders a long response intact', async () => {
  const saved = storage(); new RecoveryMemory(saved).selected('browser-session-1234');
  const text = '长输出🙂'.repeat(20000);
  const b = await browser(saved, async url => url.endsWith('/state') ? {
    status: 200, ok: true, json: async () => ({ messages: [], cursor: 99, busy: true,
      liveMessage: { role: 'assistant', content: [{type:'text', text}] } }),
  } : null);
  assert.equal(vm.runInContext('liveText', b.context), text);
  await b.document.handlers.visibilitychange();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(vm.runInContext('liveText', b.context), text);
  assert.match(b.streams.at(-1).url, /since=99/);
});

test('disabled Safari storage still allows session use', () => {
  const memory = new RecoveryMemory({ getItem() {throw Error();}, setItem() {throw Error();} });
  assert.equal(memory.selected('session-123'), null);
  assert.equal(memory.pending('session-123', { id:'test-command' }), null);
});


test('offline reload recovers authentication and selected session without re-pairing', async () => {
  const saved = storage(); new RecoveryMemory(saved).selected('browser-session-1234');
  let offline = true;
  const b = await browser(saved, async () => { if (offline) throw new Error('offline'); });
  assert.equal(b.element('appView').hidden, false);
  assert.equal(b.streams.length, 0);
  offline = false;
  await b.window.handlers.online();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(b.streams.length, 1);
  assert.equal(b.element('sessionTitle').textContent, 'Disposable test');
});


test('session is usable before SSE opens; stalled SSE falls back to polling without prompt replay', async () => {
  const saved = storage(); new RecoveryMemory(saved).selected('browser-session-1234');
  const b = await browser(saved);
  assert.match(b.element('connection').textContent, /Pi 会话已连接/);
  const source = b.streams[0];
  const watchdog = [...b.delays].find(([, delay]) => delay === 8000)[0];
  b.timers.get(watchdog)();
  assert.equal(source.closed, true);
  assert.match(b.element('connection').textContent, /自动同步/);
  const poll = [...b.delays].find(([, delay]) => delay === 0)[0];
  await b.timers.get(poll)();
  assert.ok(b.calls.filter(c => c.url.endsWith('/state')).length >= 2);
  assert.equal(b.calls.filter(c => c.url.endsWith('/commands')).length, 0);
});

test('SSE heartbeat renews its deadline and a silently stalled live stream recovers', async () => {
  const saved = storage(); new RecoveryMemory(saved).selected('browser-session-1234');
  const b = await browser(saved);
  const source = b.streams[0]; source.onopen();
  assert.ok(![...b.delays.values()].includes(8000));
  const original = [...b.delays].find(([, delay]) => delay === 45000)[0];
  source.handlers.ping();
  assert.equal(b.timers.has(original), false);
  const watchdog = [...b.delays].find(([, delay]) => delay === 45000)[0];
  b.timers.get(watchdog)();
  assert.equal(source.closed, true);
  assert.match(b.element('connection').textContent, /自动同步/);
});
