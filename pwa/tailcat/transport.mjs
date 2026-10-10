// Main-thread facade: all network bytes, keys and WASM stay in the worker.
export function createTransport() {
  const worker = new Worker(new URL('./worker.mjs', import.meta.url), {type: 'module'});
  const waiting = new Map(), streams = new Map();
  let connectedBefore = false;
  let configured = false;
  const metrics = {wasmStartupMs: null, state: 'initializing', reason: null, attempts: 0, connections: 0, handshakesMs: [], recoveriesMs: [], readRequestMs: [], failedCalls: 0};
  let recoveryStarted;
  const transport = {onRecovered: null, onDiagnostics: null, diagnostics: () => structuredClone(metrics)};
  const report = () => transport.onDiagnostics?.(transport.diagnostics());
  function call(value, signal) {
    if (waiting.size >= 8) return Promise.reject(Object.assign(new Error('请求队列已满'), {status: 429}));
    if (signal?.aborted) return Promise.reject(Object.assign(new Error('request_cancelled'), {status: 499}));
    const id = value.id || crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const abort = () => {
        const pending = waiting.get(id);
        if (!pending) return;
        pending.cleanup(); waiting.delete(id);
        worker.postMessage({type: 'cancel', id});
        reject(Object.assign(new Error('request_cancelled'), {status: 499}));
      };
      const timer = setTimeout(abort, 120000);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      waiting.set(id, {resolve, reject, cleanup, type: value.type, started: performance.now(), read: value.type === 'request' && value.op !== 'command.dispatch'});
      signal?.addEventListener('abort', abort, {once: true});
      worker.postMessage({...value, id});
    });
  }
  worker.onmessage = ({data}) => {
    if (data.type === 'boot') {
      configured = data.configured;
      metrics.wasmStartupMs = data.startupMs; metrics.state = document.hidden ? 'background' : configured ? 'offline' : 'unpaired'; report();
    } else if (data.type === 'dialing') {
      metrics.attempts++; metrics.state = 'connecting'; report();
    } else if (data.type === 'reply') {
      const pending = waiting.get(data.id);
      if (!pending) return;
      waiting.delete(data.id); pending.cleanup();
      if (pending.type === 'resume' && data.value?.configured === false) { configured = false; metrics.state = document.hidden ? 'background' : 'unpaired'; metrics.reason = null; }
      if (data.error) { metrics.failedCalls++; pending.reject(Object.assign(new Error(data.error), {status: data.status, definitive: data.definitive})); }
      else { if (pending.read) { metrics.readRequestMs.push(Math.round(performance.now() - pending.started)); metrics.readRequestMs = metrics.readRequestMs.slice(-200); } pending.resolve(data.value); }
      report();
    } else if (data.type === 'event') {
      try { streams.get(data.subscription)?.emit(data.event.type, {data: JSON.stringify(data.event.data), lastEventId: String(data.event.id)}); }
      finally { worker.postMessage({type: 'ack', id: data.id}); }
    } else if (data.type === 'pulse') {
      for (const source of streams.values()) source.emit('ping', {data: '{}'});
    } else if (data.type === 'disconnected') {
      recoveryStarted ??= performance.now(); metrics.state = 'offline'; metrics.reason = data.reason; report();
      for (const source of [...streams.values()]) source.onerror?.();
    } else if (data.type === 'connected') {
      configured = true;
      metrics.connections++; metrics.state = 'connected'; metrics.reason = null;
      metrics.handshakesMs.push(data.handshakeMs); metrics.handshakesMs = metrics.handshakesMs.slice(-200);
      if (recoveryStarted !== undefined) { metrics.recoveriesMs.push(Math.round(performance.now() - recoveryStarted)); metrics.recoveriesMs = metrics.recoveriesMs.slice(-200); recoveryStarted = undefined; }
      report();
      if (connectedBefore) transport.onRecovered?.();
      connectedBefore = true;
    } else if (data.type === 'fatal') {
      metrics.state = 'failed'; metrics.reason = data.error; report();
      for (const pending of waiting.values()) { pending.cleanup(); pending.reject(Object.assign(new Error(data.error), {status: data.status})); }
      waiting.clear();
    }
  };
  worker.onerror = () => {
    metrics.state = 'failed'; metrics.reason = 'worker_stopped'; report();
    for (const pending of waiting.values()) { pending.cleanup(); pending.reject(Object.assign(new Error('浏览器连接进程已停止，请重新加载'), {status: 503})); }
    waiting.clear();
  };
  transport.api = async (url, options = {}) => {
    if (url === '/api/login') {
      const {token} = JSON.parse(options.body);
      return call({type: 'pair', text: token, origin: location.origin}, options.signal);
    }
    const method = options.method || 'GET';
    if (url === '/api/sessions' && method === 'GET') {
      const sessions = []; let offset = 0, page;
      do {
        page = await call({type: 'request', op: 'sessions.list', args: {offset, limit: 100}}, options.signal);
        sessions.push(...page.sessions); offset = page.next;
      } while (offset !== null && sessions.length < 10000);
      return {sessions, workspaces: page.workspaces};
    }
    let match = /^\/api\/commands\/([\w-]{10,100})$/.exec(url);
    if (match && method === 'GET') return call({type: 'request', op: 'command.receipt', args: {commandId: match[1]}}, options.signal);
    const parsed = new URL(url, location.origin);
    match = /^\/api\/sessions\/([^/]+)\/(state|commands|models)$/.exec(parsed.pathname);
    if (!match) throw Object.assign(new Error('unsupported_operation'), {status: 400});
    const sessionId = decodeURIComponent(match[1]);
    if (match[2] === 'state' && method === 'GET') {
      const args = {sessionId};
      for (const key of ['offset', 'limit', 'cursor']) if (parsed.searchParams.has(key)) args[key] = Number(parsed.searchParams.get(key));
      return call({type: 'request', op: 'session.state', args}, options.signal);
    }
    if (match[2] === 'models' && method === 'GET') return call({type: 'request', op: 'models.list', args: {sessionId}}, options.signal);
    if (match[2] !== 'commands' || method !== 'POST') throw Object.assign(new Error('unsupported_operation'), {status: 400});
    const command = JSON.parse(options.body);
    command.commandId ||= crypto.randomUUID();
    return call({type: 'request', op: 'command.dispatch', args: {sessionId, command}}, options.signal);
  };
  transport.events = (sessionId, since) => {
    const id = crypto.randomUUID();
    let closed = false;
    const listeners = new Map();
    const source = {
      onopen: null, onerror: null,
      addEventListener(type, fn) { listeners.set(type, fn); },
      emit(type, event) { if (!closed) listeners.get(type)?.(event); },
      close() {
        if (closed) return;
        closed = true; streams.delete(id);
        void call({type: 'unsubscribe', subscription: id}).catch(() => {});
      }
    };
    streams.set(id, source);
    void call({type: 'subscribe', id, sessionId, since}).then(() => { if (!closed) source.onopen?.(); }).catch(() => { if (!closed) source.onerror?.(); });
    return source;
  };
  const resume = (force = false) => {
    if (document.hidden) return Promise.resolve();
    if (configured) recoveryStarted ??= performance.now();
    if (metrics.state !== 'failed') { metrics.state = configured ? 'connecting' : metrics.wasmStartupMs === null ? 'initializing' : 'unpaired'; report(); }
    return call({type: 'resume', force}).then(value => {
      if (!document.hidden && value.configured && metrics.state !== 'failed') { metrics.state = 'connected'; report(); }
      return value;
    });
  };
  transport.reconnect = () => resume(true);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (configured) recoveryStarted ??= performance.now(); metrics.state = 'background'; report(); worker.postMessage({type: 'suspend'}); } else void resume().catch(() => {});
  });
  window.addEventListener('online', () => { void resume(true).catch(() => {}); });
  window.addEventListener('pageshow', event => { void resume(event.persisted).catch(() => {}); });
  window.addEventListener('focus', () => { void resume().catch(() => {}); });
  if (document.hidden) worker.postMessage({type: 'suspend'});
  return transport;
}
