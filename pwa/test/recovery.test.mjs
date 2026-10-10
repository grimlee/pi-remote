import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { RecoveryMemory, messageFingerprint, prefersPolling } from '../public/recovery.js';

function storage() {
  const items = new Map();
  return { getItem: k => items.get(k) ?? null, setItem: (k, v) => items.set(k, v), removeItem: k => items.delete(k), items };
}
async function browser(saved = storage(), fetchHook, browserOptions = {}) {
  const nodes = new Map();
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, {
      id, value: '', textContent: '', hidden: false, disabled: false, children: [], handlers: {},
      scrollHeight: 0, scrollTop: 0, clientHeight: 0,
      classList: { add() {}, remove() {} },
      addEventListener(type, fn) { this.handlers[type] = fn; },
      append(...items) { this.children.push(...items); for (const item of items) item.parentElement = this; },
      remove() { const items=this.parentElement?.children; if(items) items.splice(items.indexOf(this),1); },
      replaceChildren(...items) { this.children = items; for(const item of items) item.parentElement=this; },
      insertBefore(item, before) {const i=this.children.indexOf(before);if(i<0)this.append(item);else{this.children.splice(i,0,item);item.parentElement=this;}},
      replaceWith(item) {const a=this.parentElement?.children;if(a){a.splice(a.indexOf(this),1,item);item.parentElement=this.parentElement;}},
    });
    return nodes.get(id);
  };
  const session = { id: 'browser-session-1234', name: 'Disposable test', cwd: '/tmp/test' };
  const streams = [];
  const calls = [];
  const window = { localStorage: saved, innerHeight:844, visualViewport:browserOptions.visualViewport, handlers: {}, addEventListener(k, fn) { this.handlers[k] = fn; } };
  const properties = new Map();
  const document = { hidden: false, handlers: {}, documentElement:{style:{setProperty:(k,v)=>properties.set(k,v),getPropertyValue:k=>properties.get(k)}}, getElementById: element,
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
  const context = vm.createContext({ document, window, navigator: browserOptions.navigator || {}, location: browserOptions.location || {}, EventSource, fetch,
    readImages:async()=>[],
    renderContent:(node,message)=>{node.textContent=typeof message.content==='string'?message.content:(message.content||[]).filter(p=>p?.type==='text').map(p=>p.text).join('\n');},contentForCopy:message=>(message.content||[]).filter(p=>p?.type==='text').map(p=>p.text).join('\n'),
    crypto: webcrypto, TextEncoder, RecoveryMemory, messageFingerprint, prefersPolling, AbortController, URLSearchParams,
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, fn); delays.set(id, delay); return id; },
    clearTimeout(id) { timers.delete(id); delays.delete(id); } });
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  vm.runInContext(source.replace(/^import .*\n/gm, ''), context);
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
  const retry = [...b.timers.values()].at(-1); await retry();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(b.streams.length, 3);
  assert.ok(b.calls.filter(c => c.url.endsWith("/state")).length >= 4);
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
  assert.match(b.element('connection').textContent, /稳定同步/);
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
  assert.match(b.element('connection').textContent, /稳定同步/);
});


test('iPhone and iPad default to short requests, with an explicit transport override', () => {
  assert.equal(prefersPolling({ userAgent: 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15' }, {}), true);
  assert.equal(prefersPolling({ userAgent: 'Macintosh', maxTouchPoints: 5 }, {}), true);
  assert.equal(prefersPolling({ userAgent: 'Linux' }, { search: '?transport=poll' }), true);
  assert.equal(prefersPolling({ userAgent: 'iPhone' }, { search: '?transport=stream' }), false);
});

test('iOS polling survives foreground, network transitions, and reload without opening SSE', async () => {
  const saved = storage(); new RecoveryMemory(saved).selected('browser-session-1234');
  const opts = { navigator: { userAgent: 'iPhone' } };
  const b = await browser(saved, null, opts);
  assert.equal(b.streams.length, 0);
  assert.match(b.element('connection').textContent, /稳定同步模式/);
  await b.document.handlers.visibilitychange();
  await new Promise(resolve => setImmediate(resolve));
  await b.window.handlers.online();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(b.streams.length, 0);
  const reloaded = await browser(saved, null, opts);
  assert.equal(reloaded.streams.length, 0);
  assert.equal(reloaded.calls.filter(c => c.url.endsWith('/commands')).length, 0);
});

test('iOS transient Load failed retries polling and never retries commands automatically', async () => {
  const saved = storage(); new RecoveryMemory(saved).selected('browser-session-1234');
  let failed = false;
  const b = await browser(saved, async url => {
    if (failed && url.endsWith('/state')) throw new TypeError('Load failed');
  }, { navigator: { userAgent: 'iPhone' } });
  failed = true;
  let timer = [...b.delays].find(([, delay]) => delay === 3000)[0];
  await b.timers.get(timer)();
  assert.match(b.element('connection').textContent, /Load failed/);
  timer = [...b.delays].find(([, delay]) => delay === 6000)[0];
  failed = false;
  await b.timers.get(timer)();
  assert.match(b.element('connection').textContent, /稳定同步模式/);
  assert.equal(b.streams.length, 0);
  assert.equal(b.calls.filter(c => c.url.endsWith('/commands')).length, 0);
});

test('a prompt cancels an in-flight history download before dispatch and restarts polling', async () => {
  const saved = storage(); new RecoveryMemory(saved).selected('browser-session-1234');
  let stall = false, cancelled = false;
  const b = await browser(saved, async (url, options) => {
    if (stall && url.endsWith('/state')) return await new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => { cancelled = true; reject(new DOMException('cancelled','AbortError')); });
    });
    if (url.endsWith('/commands')) {
      assert.equal(cancelled, true);
      return { status: 202, ok: true, json: async () => ({status:'accepted'}) };
    }
  }, { navigator: { userAgent: 'iPhone' } });
  stall = true;
  const timer = [...b.delays].find(([, delay]) => delay === 3000)[0];
  const downloading = b.timers.get(timer)();
  await new Promise(resolve => setImmediate(resolve));
  b.element('prompt').value = 'one disposable prompt';
  await b.element('composer').handlers.submit({ preventDefault() {} });
  await downloading;
  assert.equal(b.calls.filter(c => c.url.endsWith('/commands')).length, 1);
  assert.equal(b.element('prompt').value, '');
  assert.equal(b.streams.length, 0);
});

test('an accepted receipt clears an unchanged ambiguous draft before another send', async () => {
  const saved = storage(); const memory = new RecoveryMemory(saved);memory.selected('browser-session-1234');
  let accepted = false;
  const b = await browser(saved, async url => {
    if (url.endsWith('/commands')) throw new TypeError('Load failed');
    if (url.startsWith('/api/commands/')) return { status: 200, ok: true, json: async () => ({status:accepted?'accepted':'unknown'}) };
  }, {navigator:{userAgent:'iPhone'}});
  b.element('prompt').value = 'ambiguous disposable prompt';
  await b.element('composer').handlers.submit({preventDefault(){}});
  assert.ok(memory.pending(b.session.id));
  accepted = true;
  const timer = [...b.delays].find(([, delay]) => delay === 3000)[0];await b.timers.get(timer)();
  assert.equal(b.element('prompt').value, '');
  assert.equal(memory.pending(b.session.id), null);
  assert.equal(b.calls.filter(c=>c.url.endsWith('/commands')).length,1);
});


test('a truncated successful HTTP response is a failed sync and does not erase history', async () => {
  const saved = storage(); new RecoveryMemory(saved).selected('browser-session-1234');
  let broken = false;
  const b = await browser(saved, async url => url.endsWith('/state') ? {
    status: 200, ok: true, json: async () => {
      if (broken) throw new TypeError('Load failed');
      return {messages:[],busy:true,cursor:7,liveMessage:{role:'assistant',content:[{type:'text',text:'preserved partial history'}]}};
    }
  } : null, {navigator:{userAgent:'iPhone'}});
  assert.equal(vm.runInContext('liveText',b.context),'preserved partial history');
  broken = true;
  const timer = [...b.delays].find(([,delay])=>delay===1000)[0];await b.timers.get(timer)();
  assert.equal(vm.runInContext('liveText',b.context),'preserved partial history');
  assert.match(b.element('connection').textContent,/Load failed/);
});


test('startup authenticates through the session list without a redundant auth request', async () => {
  const saved = storage(); new RecoveryMemory(saved).selected('browser-session-1234');
  const b = await browser(saved, null, {navigator:{userAgent:'iPhone'}});
  assert.equal(b.calls.filter(c => c.url === '/api/auth').length, 0);
  assert.equal(b.calls.filter(c => c.url === '/api/sessions').length, 1);
  assert.equal(b.calls.filter(c => c.url.endsWith('/state')).length, 1);
  const denied = await browser(saved, async url => url === '/api/sessions' ? {
    status:401,ok:false,json:async()=>({error:'not_authenticated'})
  } : null);
  assert.equal(denied.element('loginView').hidden, false);
  assert.equal(denied.calls.filter(c=>c.url.endsWith('/state')).length, 0);
});

test('busy polling responds every second, backs off failures, and returns to idle cadence', async () => {
  const saved = storage(); new RecoveryMemory(saved).selected('browser-session-1234');
  let busy = true, failed = false;
  const b = await browser(saved, async url => {
    if (url.endsWith('/state')) {
      if (failed) throw new TypeError('Load failed');
      return {status:200,ok:true,json:async()=>({messages:[],busy,cursor:12})};
    }
  }, {navigator:{userAgent:'iPhone'}});
  const fire = async delay => {
    const entry = [...b.delays].find(([, d])=>d===delay);
    assert.ok(entry, 'expected polling interval '+delay);
    const fn=b.timers.get(entry[0]);b.timers.delete(entry[0]);b.delays.delete(entry[0]);await fn();
  };
  failed=true; await fire(1000);
  assert.ok([...b.delays.values()].includes(2000));
  failed=false; await fire(2000);
  assert.ok([...b.delays.values()].includes(1000));
  busy=false; await fire(1000);
  assert.ok([...b.delays.values()].includes(3000));
  assert.equal(b.calls.filter(c=>c.url.endsWith('/commands')).length,0);
  assert.equal(b.streams.length,0);
});

test('mobile sidebar has a dismissible backdrop and compact searchable workspace groups', async () => {
  const b = await browser();
  const backdrop = b.element('sidebarBackdrop');
  b.element('openSidebar').handlers.click();
  assert.equal(backdrop.hidden, false);
  backdrop.handlers.click();
  assert.equal(backdrop.hidden, true);
  const list = b.element('sessions');
  assert.equal(list.children.length, 1);
  const workspace = list.children[0];
  assert.match(workspace.children[0].children[0].textContent, /tmp \/ test/);
  workspace.children[0].handlers.click();
  assert.equal(list.children[0].children.length, 1, 'workspace should collapse');
  const search = b.element('sessionSearch');
  search.value = 'Disposable';
  search.handlers.input();
  assert.equal(list.children[0].children.length, 2, 'search expands matching collapsed group');
  search.value = 'missing session';
  search.handlers.input();
  assert.match(list.children[0].textContent, /没有找到匹配/);
});

test('identical iOS polling snapshots preserve existing transcript DOM nodes', async () => {
  const saved = storage();
  new RecoveryMemory(saved).selected('browser-session-1234');
  const b = await browser(saved, null, { navigator: { userAgent: 'iPhone' } });
  const first = b.element('messages').children[0];
  const poll = [...b.delays].find(([, delay]) => delay === 3000);
  assert.ok(poll, 'a mobile polling timer is scheduled');
  await b.timers.get(poll[0])();
  assert.equal(b.element('messages').children[0], first);
});

test('repeated live snapshots do not append already-rendered text twice', async () => {
  const saved = storage();
  new RecoveryMemory(saved).selected('browser-session-1234');
  const responseText = 'hello 🙂 '.repeat(1000);
  const b = await browser(saved, async url => url.endsWith('/state') ? {
    status: 200, ok: true, json: async () => ({
      messages: [], cursor: 17, busy: true,
      liveMessage: { role: 'assistant', content: [{ type: 'text', text: responseText }] }
    })
  } : null, { navigator: { userAgent: 'iPhone' } });
  assert.equal(vm.runInContext('liveText', b.context), responseText);
  const poll = [...b.delays].find(([, delay]) => delay === 1000);
  assert.ok(poll);
  await b.timers.get(poll[0])();
  assert.equal(vm.runInContext('liveText', b.context), responseText);
});

test('message copy reads the current full message text', async () => {
  let clipboardText;
  const b = await browser(storage(), null, {
    navigator: { clipboard: { writeText: async text => { clipboardText = text; } } }
  });
  const rendered = vm.runInContext('makeMessage("assistant", "copy this message")', b.context);
  const copy = rendered.block.children[0].children[1];
  copy.handlers.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(clipboardText, 'copy this message');
});


test('authoritative snapshots remove stale live text when it disappears without transcript changes', async () => {
  const saved=storage();new RecoveryMemory(saved).selected('browser-session-1234');
  const b=await browser(saved, async url=>url.endsWith('/state')?{
    status:200,ok:true,json:async()=>({messages:[],busy:true,liveMessage:{role:'assistant',content:[{type:'text',text:'partial reply'}]}})
  }:null,{navigator:{userAgent:'iPhone'}});
  const before=b.element('messages').children.length;
  vm.runInContext('renderSnapshot({messages:[],busy:false,liveMessage:null})',b.context);
  assert.equal(vm.runInContext('liveText',b.context),'');
  assert.equal(b.element('messages').children.length,before-1);
  vm.runInContext('renderSnapshot({messages:[],busy:true,liveMessage:{role:"assistant",content:[{type:"text",text:"next partial"}]}})',b.context);
  vm.runInContext('renderSnapshot({messages:[],busy:true,liveMessage:null})',b.context);
  assert.equal(vm.runInContext('liveText',b.context),'');
  assert.equal(b.element('messages').children.length,before-1);
});

test('visual viewport shrink updates shell height and keeps the composer bounded', async () => {
  const viewport={height:844,handlers:{},addEventListener(k,fn){this.handlers[k]=fn;}};
  const b=await browser(storage(),null,{visualViewport:viewport});
  const prompt=b.element('prompt');prompt.style={};prompt.scrollHeight=450;
  assert.equal(b.document.documentElement.style.getPropertyValue('--app-height'),'844px');
  viewport.height=380;viewport.handlers.resize();
  assert.equal(b.document.documentElement.style.getPropertyValue('--app-height'),'380px');
  assert.ok(parseFloat(prompt.style.height)<=380*.28);
});

test('jump-to-latest position follows the expanded composer height', async () => {
  const b=await browser();b.element('prompt').style={};b.element('prompt').scrollHeight=190;
  b.element('composer').getBoundingClientRect=()=>({height:250});
  vm.runInContext('resizeComposer()',b.context);
  assert.equal(b.document.documentElement.style.getPropertyValue('--composer-height'),'250px');
});


test('the selected workspace header uses a compact label and preserves the full path as a tooltip', async () => {
  const saved=storage();new RecoveryMemory(saved).selected('browser-session-1234');
  const b=await browser(saved);
  assert.equal(b.element('sessionSub').textContent,'tmp / test');
  assert.equal(b.element('sessionSub').title,'/tmp/test');
});
