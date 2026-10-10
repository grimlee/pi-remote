import { RecoveryMemory, messageFingerprint, prefersPolling } from "./recovery.js";
import { renderContent, contentForCopy } from "./transcript.js";
const $ = id => document.getElementById(id);
const loginView = $("loginView");
const appView = $("appView");
const sidebar = $("sidebar");
const sessionsView = $("sessions");
const messagesView = $("messages");
const promptBox = $("prompt");
const sessionSearch = $("sessionSearch");
const sidebarBackdrop = $("sidebarBackdrop");
const jumpLatest = $("jumpLatest");
const connection = $("connection");
const activity = $("activity");
let sessions = [];
let current = null;
let stream = null;
let epoch = 0;
let liveText = "";
let liveNode = null;
let liveBlock = null;
let syncTimer = null;
let pendingCommand = null;
let synchronizing = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
let submitting = false;
let streamWatchdog = null;
let pollTimer = null;
let realtimeConnected = false;
let pollingOnly = prefersPolling(navigator, location);
let agentBusy = false;
let activeStateRead = null;
let lastRenderedSnapshot = null;
const renderedNodes = new Map();
let liveSignature = null;
let renderTools = {};
const collapsedWorkspaces = new Set();
function pauseStateReads() {
  clearTimeout(pollTimer);
  pollTimer = null;
  if (activeStateRead) activeStateRead.abort();
}
function connectTransport(id, cursor, expectedEpoch) {
  if (pollingOnly) startPolling(expectedEpoch);
  else {
    setConnection("Pi 会话已连接 · 正在建立实时连接…", "good");
    attachStream(id, cursor, expectedEpoch);
  }
}
function clearRealtimeTimers() {
  clearTimeout(streamWatchdog);
  clearTimeout(pollTimer);
  streamWatchdog = pollTimer = null;
  realtimeConnected = false;
}
function startPolling(expectedEpoch, immediate = false) {
  clearTimeout(pollTimer);
  setConnection(pollingOnly ? "Pi 会话已连接 · 稳定同步模式" : "会话已连接 · 自动同步中", "good");
  const interval = () => agentBusy ? 1000 : 3000;
  let delay = interval();
  const poll = async () => {
    if (expectedEpoch !== epoch || realtimeConnected || !current || submitting) return;
    const ok = await syncState(expectedEpoch);
    delay = ok ? interval() : Math.min(delay * 2, 15000);
    if (expectedEpoch === epoch && !realtimeConnected && current && !submitting) pollTimer = setTimeout(poll, delay);
  };
  pollTimer = setTimeout(poll, immediate ? 0 : delay);
}
let storage;
try { storage = window.localStorage; } catch {}
const memory = new RecoveryMemory(storage);
function retryRecovery(expectedEpoch = epoch) {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    if (expectedEpoch === epoch) void recoverSession();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 15000);
}

function setConnection(message, kind = "") {
  connection.textContent = message;
  connection.className = "connection " + kind;
}
function setActivity(message) { activity.textContent = message; }
async function api(url, options = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  const deadline = setTimeout(abort, options.method === "POST" ? 45000 : 20000);
  try {
    const response = await fetch(url, {
      credentials: "same-origin",
      cache: "no-store",
      ...options,
      signal: controller.signal
    });
    let value;
    try { value = await response.json(); } catch (err) {
      if (response.ok) throw err;
      value = {};
    }
    if (response.status === 401 && url !== "/api/login") showLogin();
    if (!response.ok) throw Object.assign(new Error(value.error || value.status || "HTTP " + response.status), { status: response.status });
    return value;
  } finally {
    clearTimeout(deadline);
    options.signal?.removeEventListener("abort", abort);
  }
}
function showLogin() {
  epoch++;
  clearTimeout(reconnectTimer);
  clearTimeout(syncTimer);
  clearRealtimeTimers();
  pauseStateReads();
  current = null;
  lastRenderedSnapshot = null;
  agentBusy = false;
  if (stream) { stream.close(); stream = null; }
  appView.hidden = true;
  loginView.hidden = false;
  $("loginError").textContent = "";
}
function showApp() {
  loginView.hidden = true;
  appView.hidden = false;
}
function sessionLabel(s) {
  return s.name || s.id.slice(0, 12);
}
function relativeDate(value) {
  const ms = Date.now() - Date.parse(value);
  if (!Number.isFinite(ms)) return "";
  if (ms < 60000) return "刚刚";
  if (ms < 3600000) return Math.floor(ms / 60000) + " 分钟前";
  if (ms < 86400000) return Math.floor(ms / 3600000) + " 小时前";
  return new Date(value).toLocaleDateString();
}
function workspaceLabel(cwd) {
  const parts = String(cwd || "").split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join(" / ") || cwd || "未命名工作区";
}
function modelLabel(model) {
  return String(model || "Pi").split("/").pop();
}
function renderSessions() {
  sessionsView.replaceChildren();
  const query = (sessionSearch.value || "").trim().toLocaleLowerCase();
  const filtered = query
    ? sessions.filter(s => [s.name, s.cwd, s.model, s.id].some(v =>
      String(v || "").toLocaleLowerCase().includes(query)))
    : sessions;
  if (!filtered.length) {
    const empty = document.createElement("div");
    empty.className = "session-empty";
    empty.textContent = sessions.length
      ? "没有找到匹配的会话"
      : "没有发现 Pi 会话，请先在电脑上创建会话。";
    sessionsView.append(empty);
    return;
  }
  const groups = new Map();
  for (const session of filtered) {
    if (!groups.has(session.cwd)) groups.set(session.cwd, []);
    groups.get(session.cwd).push(session);
  }
  for (const [cwd, items] of groups) {
    const section = document.createElement("section");
    section.className = "workspace";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "workspace-toggle";
    toggle.title = cwd;
    const expanded = query || !collapsedWorkspaces.has(cwd);
    toggle.setAttribute?.("aria-expanded", String(!!expanded));
    const label = document.createElement("span");
    label.className = "workspace-name";
    label.textContent = workspaceLabel(cwd);
    const count = document.createElement("span");
    count.className = "workspace-count";
    count.textContent = String(items.length);
    toggle.append(label, count);
    toggle.addEventListener("click", () => {
      if (collapsedWorkspaces.has(cwd)) collapsedWorkspaces.delete(cwd);
      else collapsedWorkspaces.add(cwd);
      renderSessions();
    });
    section.append(toggle);
    if (expanded) {
      const children = document.createElement("div");
      children.className = "workspace-sessions";
      for (const session of items) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "session" + (current?.id === session.id ? " active" : "");
        button.setAttribute?.("aria-current", current?.id === session.id ? "page" : "false");
        const name = document.createElement("span");
        name.className = "name";
        name.textContent = sessionLabel(session);
        const meta = document.createElement("span");
        meta.className = "meta";
        meta.textContent = modelLabel(session.model) + " · " + relativeDate(session.updatedAt);
        button.append(name, meta);
        button.addEventListener("click", () => void openSession(session));
        children.append(button);
      }
      section.append(children);
    }
    sessionsView.append(section);
  }
}
function acceptSessions(data) {
  sessions = data.sessions || [];
  renderSessions();
  if (!current) setConnection("Host 已连接 · 等待选择会话", "good");
}
async function loadSessions() {
  try {
    const data = await api("/api/sessions");
    acceptSessions(data);
  } catch (err) {
    setConnection("无法获取会话：" + err.message, "bad");
    if (!appView.hidden && !current) {
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => void restoreSelection(), 3000);
    }
  }
}
function textContentOf(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter(p => p?.type === "text" && typeof p.text === "string")
    .map(p => p.text).join("\n");
}
function atBottom() {
  return messagesView.scrollHeight - messagesView.scrollTop - messagesView.clientHeight < 140;
}
function updateJumpButton() {
  jumpLatest.hidden = !current || atBottom();
}
function scrollBottom() {
  messagesView.scrollTop = messagesView.scrollHeight;
  updateJumpButton();
}
function setSidebarOpen(open) {
  if (open) sidebar.classList.add("open");
  else sidebar.classList.remove("open");
  sidebarBackdrop.hidden = !open;
  $("openSidebar").setAttribute?.("aria-expanded", String(open));
}
function resizeComposer() {
  if (!promptBox.style) return;
  const maxHeight = Math.min(190, (window.visualViewport?.height || window.innerHeight || 760) * 0.28);
  promptBox.style.height = "auto";
  promptBox.style.height = Math.min(Math.max(promptBox.scrollHeight, 50), maxHeight) + "px";
  const height = $("composer").getBoundingClientRect?.().height;
  if (height > 0) document.documentElement.style.setProperty("--composer-height", height + "px");
}
function syncViewport() {
  const height = window.visualViewport?.height || window.innerHeight;
  if (height > 0) document.documentElement.style.setProperty("--app-height", height + "px");
  resizeComposer();
}
async function copyMessage(text) {
  try {
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
    await navigator.clipboard.writeText(text);
    setActivity("消息已复制");
  } catch {
    setActivity("无法自动复制，请长按选中文字");
  }
}
function makeMessage(role, text, message = null) {
  const block = document.createElement("section");
  block.className = "message " + role;
  const heading = document.createElement("div");
  heading.className = "message-head";
  const label = document.createElement("div");
  label.className = "role";
  label.textContent = role === "user" ? "你" : role === "assistant" ? "Pi" : "工具";
  const body = document.createElement("div");
  body.className = "content";
  body.textContent = text;
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "copy-action";
  copy.textContent = "复制";
  copy.setAttribute?.("aria-label", "复制消息内容");
  copy.addEventListener("click", () => {
    void copyMessage(message ? contentForCopy(message) : body.textContent);
  });
  heading.append(label, copy);
  block.append(heading, body);
  if (message) renderContent(body, message, copyMessage, renderTools);
  return { block, body };
}
function renderMessages(messages) {
  const visible = (messages || []).slice(-160);
  const signature = JSON.stringify([visible, renderTools]);
  if (signature === lastRenderedSnapshot) { updateJumpButton(); return; }
  lastRenderedSnapshot = signature;
  const nearBottom = atBottom();
  const keep = new Set();
  for (let i=0; i<visible.length; i++) {
    const message = visible[i]; if (!message) continue;
    const key = String((messages || []).length - visible.length + i);
    keep.add(key);
    const sig = JSON.stringify([message, renderTools]);
    let item = renderedNodes.get(key);
    if (!item || item.signature !== sig) {
      const open = item?.body.querySelectorAll?.('details[open]');
      const opened = new Set(open ? [...open].map(d=>d.dataset.detailKey) : []);
      const next = makeMessage(message.role, '', message); next.signature = sig;
      if (item) item.block.replaceWith(next.block);
      else messagesView.insertBefore(next.block, liveBlock);
      for (const detail of next.body.querySelectorAll?.('details') || []) detail.open = opened.has(detail.dataset.detailKey);
      item = next; renderedNodes.set(key,item);
    }
  }
  for (const [key,item] of renderedNodes) if (!keep.has(key)) {item.block.remove(); renderedNodes.delete(key);}
  if (nearBottom) scrollBottom(); else updateJumpButton();
}
function setLiveText(text) {
  if (!current || !text || text === liveText) return;
  const nearBottom = atBottom();
  if (!liveNode) {
    const item = makeMessage("assistant", "");
    liveNode = item.body;
    liveBlock = item.block;
    messagesView.append(item.block);
  }
  liveText = text;
  liveNode.textContent = text;
  if (nearBottom) scrollBottom();
  else updateJumpButton();
}
function appendLive(delta) {
  if (delta) setLiveText(liveText + delta);
}
function renderSnapshot(data) {
  agentBusy = !!data.busy;
  renderTools = {};
  for (const m of data.messages || []) if (m?.role==='toolResult') renderTools[m.toolCallId] = {status:m.isError?'失败':'成功'};
  for (const t of data.tools || []) renderTools[t.toolCallId] = {status:t.status};
  renderMessages(data.messages);
  const message = data.busy && data.liveMessage;
  const sig = message ? JSON.stringify([message,renderTools]) : null;
  if (message && sig !== liveSignature) {
    const nearBottom = atBottom();
    if (!liveNode) {const item=makeMessage('assistant','');liveNode=item.body;liveBlock=item.block;messagesView.append(item.block);}
    const opened = new Set([...(liveNode.querySelectorAll?.('details[open]') || [])].map(d=>d.dataset.detailKey));
    renderContent(liveNode,message,copyMessage,renderTools);
    for (const d of liveNode.querySelectorAll?.('details') || []) d.open=opened.has(d.dataset.detailKey);
    liveText=textContentOf(message);liveSignature=sig;
    if(nearBottom) scrollBottom();else updateJumpButton();
  } else if (!message && liveNode) {
    liveBlock?.remove();liveBlock=liveNode=null;liveText='';liveSignature=null;updateJumpButton();
  }
}
async function syncState(expectedEpoch = epoch) {
  if (!current || expectedEpoch !== epoch || synchronizing === expectedEpoch || submitting) return false;
  synchronizing = expectedEpoch;
  const read = new AbortController();
  activeStateRead = read;
  try {
    const data = await api("/api/sessions/" + encodeURIComponent(current.id) + "/state", { signal: read.signal });
    if (expectedEpoch !== epoch) return;
    renderSnapshot(data);
    setActivity(data.busy ? "Pi 正在工作" : "会话已同步");
    setConnection(realtimeConnected ? "已连接 · 会话状态已同步" : "Pi 会话已连接 · 稳定同步模式", "good");
    await reconcileCommand(current.id, read.signal);
    return true;
  } catch (err) {
    if (expectedEpoch === epoch && !read.signal.aborted) setConnection("网络请求失败，正在自动重试：" + err.message, "bad");
    return false;
  } finally {
    if (activeStateRead === read) activeStateRead = null;
    if (synchronizing === expectedEpoch) synchronizing = null;
  }
}
function scheduleSync(delay = 280) {
  clearTimeout(syncTimer);
  const expectedEpoch = epoch;
  syncTimer = setTimeout(() => void syncState(expectedEpoch), delay);
}
function processRpc(payload) {
  if (!current || !payload) return;
  const type = payload.type;
  if (type === "agent_start") setActivity("Pi 正在思考…");
  if (type === "tool_execution_start") {
    setActivity("正在执行工具：" + (payload.toolName || "tool"));
  }
  if (type === "message_update" || type.startsWith("tool_execution_")) scheduleSync(280);
  if (type === "agent_settled" || type === "agent_end" || type === "turn_end" || type === "message_end") {
    setActivity("本轮结束");
    scheduleSync(type === "message_end" ? 350 : 0);
  }
}
function attachStream(id, since, expectedEpoch) {
  if (stream) stream.close();
  clearTimeout(streamWatchdog);
  realtimeConnected = false;
  const source = new EventSource("/api/sessions/" + encodeURIComponent(id) + "/events?since=" + since);
  stream = source;
  const active = () => expectedEpoch === epoch && stream === source;
  const fail = () => {
    if (!active()) return;
    clearTimeout(streamWatchdog);
    source.close();
    stream = null;
    realtimeConnected = false;
    // Latch to short requests instead of endlessly retrying a stalled stream.
    pollingOnly = true;
    clearTimeout(reconnectTimer);
    startPolling(expectedEpoch, true);
  };
  const watch = delay => {
    clearTimeout(streamWatchdog);
    streamWatchdog = setTimeout(fail, delay);
  };
  source.addEventListener("rpc", event => {
    if (!active()) return;
    watch(45000);
    try { processRpc(JSON.parse(event.data)); } catch {}
  });
  source.addEventListener("ping", () => { if (active()) watch(45000); });
  source.addEventListener("reset", () => {
    if (active()) void recoverSession();
  });
  source.onopen = () => {
    if (!active()) return;
    clearTimeout(reconnectTimer);
    clearTimeout(pollTimer);
    pollTimer = null;
    realtimeConnected = true;
    reconnectDelay = 1000;
    watch(45000);
    setConnection("实时事件流已连接", "good");
    scheduleSync(180);
  };
  source.onerror = fail;
  // Safari/VPN proxies can stall SSE without firing onerror.
  watch(8000);
}
async function reconcileCommand(id, signal) {
  const pending = memory.pending(id);
  if (!pending) return;
  try {
    const receipt = await api("/api/commands/" + encodeURIComponent(pending.id), signal ? { signal } : {});
    if (memory.pending(id)?.id !== pending.id) return;
    if (receipt.status === "accepted") {
      if (current?.id === id && await messageFingerprint(promptBox.value) === pending.fingerprint) {
        promptBox.value = "";
        resizeComposer();
      }
      if (memory.pending(id)?.id !== pending.id) return;
      memory.pending(id, null);
      if (current?.id === id) {
        pendingCommand = null;
        setActivity("上次命令已确认接收");
      }
    } else if (current?.id === id) {
      setActivity("上次命令状态未确认；请检查会话，命令不会自动重发");
    }
  } catch { /* A missing/ambiguous receipt is never automatically re-dispatched. */ }
}
async function recoverSession() {
  if (!current) { if (!appView.hidden) await bootstrap(); return; }
  const session = current;
  const thisEpoch = ++epoch;
  clearTimeout(reconnectTimer);
  clearTimeout(syncTimer);
  clearRealtimeTimers();
  pauseStateReads();
  if (stream) { stream.close(); stream = null; }
  try {
    // Restore completed messages and the authoritative in-flight assistant snapshot.
    const data = await api("/api/sessions/" + encodeURIComponent(session.id) + "/state");
    if (thisEpoch !== epoch) return;
    renderSnapshot(data);
    setActivity(data.busy ? "Pi 正在运行" : "会话已恢复");
    connectTransport(session.id, data.cursor, thisEpoch);
    await reconcileCommand(session.id);
  } catch (err) {
    if (thisEpoch !== epoch) return;
    setConnection("恢复失败，正在自动重试：" + err.message, "bad");
    retryRecovery(thisEpoch);
  }
}
async function openSession(session) {
  epoch++;
  const thisEpoch = epoch;
  current = session;
  agentBusy = false;
  memory.selected(session.id);
  pendingCommand = memory.pending(session.id);
  clearTimeout(reconnectTimer);
  clearTimeout(syncTimer);
  promptBox.value = "";
  resizeComposer();
  clearRealtimeTimers();
  pauseStateReads();
  if (stream) { stream.close(); stream = null; }
  setSidebarOpen(false);
  renderSessions();
  $("sessionTitle").textContent = sessionLabel(session);
  $("sessionSub").textContent = workspaceLabel(session.cwd);
  $("sessionSub").title = session.cwd;
  promptBox.disabled = false;
  $("send").disabled = false;
  $("stop").disabled = false;
  lastRenderedSnapshot = null;
  renderedNodes.clear();liveSignature=null;liveBlock=liveNode=null;liveText="";
  messagesView.textContent = "正在载入会话…";
  setConnection("连接 Pi RPC…");
  try {
    const data = await api("/api/sessions/" + encodeURIComponent(session.id) + "/state");
    if (thisEpoch !== epoch) return;
    renderSnapshot(data);
    setActivity(data.busy ? "Pi 正在运行" : "准备就绪");
    connectTransport(session.id, data.cursor, thisEpoch);
    await reconcileCommand(session.id);
  } catch (err) {
    if (thisEpoch === epoch) {
      setConnection("无法连接会话，正在重试：" + err.message, "bad");
      retryRecovery(thisEpoch);
    }
  }
}
$("loginForm").addEventListener("submit", async event => {
  event.preventDefault();
  const token = $("token").value;
  $("loginError").textContent = "";
  try {
    await api("/api/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token })
    });
    $("token").value = "";
    showApp();
    await restoreSelection();
  } catch (err) {
    $("loginError").textContent = "连接失败：" + err.message;
  }
});
$("composer").addEventListener("submit", async event => {
  event.preventDefault();
  if (!current || submitting) return;
  const sessionId = current.id;
  const message = promptBox.value;
  if (!message.trim()) return;
  submitting = true;
  pauseStateReads();
  $("send").disabled = true;
  setActivity("提交命令中…");
  try {
    const fingerprint = await messageFingerprint(message);
    let command = memory.pending(sessionId) || pendingCommand;
    if (!command || command.fingerprint !== fingerprint || command.sessionId !== sessionId) {
      command = { id: crypto.randomUUID(), fingerprint, sessionId };
    }
    // Save before dispatch, so reloads and lost HTTP responses retain the same ID.
    pendingCommand = command;
    memory.pending(sessionId, command);
    const result = await api("/api/sessions/" + encodeURIComponent(sessionId) + "/commands", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "prompt", message, commandId: command.id })
    });
    if (result.status === "unknown") {
      if (current?.id === sessionId) setActivity("命令状态未确认；再次发送将查询同一命令 ID，不会重复执行");
      return;
    }
    memory.pending(sessionId, null);
    if (current?.id !== sessionId) return;
    if (promptBox.value === message) {
      promptBox.value = "";
      resizeComposer();
    }
    pendingCommand = null;
    agentBusy = true;
    setActivity("命令已接收，等待 Pi 输出…");
    scheduleSync(400);
  } catch (err) {
    if (current?.id === sessionId) {
      setActivity("发送结果未知；请确认会话状态，重试相同文本不会重复提交");
      setConnection("命令状态：" + err.message, "bad");
    }
  } finally {
    submitting = false;
    $("send").disabled = !current;
    if (current && pollingOnly) startPolling(epoch);
  }
});
promptBox.addEventListener("keydown", event => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    $("composer").requestSubmit();
  }
});
$("stop").addEventListener("click", async () => {
  if (!current) return;
  try {
    pauseStateReads();
    await api("/api/sessions/" + encodeURIComponent(current.id) + "/commands", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "abort" })
    });
    setActivity("已发送停止请求");
  } catch (err) { setActivity("停止失败：" + err.message); }
  finally { if (current && pollingOnly) startPolling(epoch); }
});
$("refreshSessions").addEventListener("click", () => void loadSessions());
$("syncButton").addEventListener("click", () => scheduleSync(0));
$("openSidebar").addEventListener("click", () => setSidebarOpen(true));
$("closeSidebar").addEventListener("click", () => setSidebarOpen(false));
sidebarBackdrop.addEventListener("click", () => setSidebarOpen(false));
sessionSearch.addEventListener("input", () => renderSessions());
jumpLatest.addEventListener("click", () => scrollBottom());
messagesView.addEventListener("scroll", updateJumpButton, { passive: true });
promptBox.addEventListener("input", resizeComposer);
document.addEventListener("keydown", event => {
  if (event.key === "Escape") setSidebarOpen(false);
});
window.addEventListener("resize", syncViewport);
window.visualViewport?.addEventListener("resize", syncViewport);
syncViewport();
window.addEventListener("online", () => void recoverSession());
window.addEventListener("pageshow", event => { if (event.persisted) void recoverSession(); });
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void recoverSession();
});
async function restoreSelection(data) {
  if (data) acceptSessions(data);
  else await loadSessions();
  const selected = sessions.find(s => s.id === memory.selected());
  if (selected) await openSession(selected);
}
async function bootstrap() {
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
  try {
    // The session list is authenticated already; avoid a separate mobile round trip.
    const data = await api("/api/sessions");
    clearTimeout(reconnectTimer);
    showApp();
    await restoreSelection(data);
  } catch (err) {
    if (err.status === 401) { showLogin(); return; }
    showApp();
    setConnection("主机暂不可达，正在自动恢复…", "bad");
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => void bootstrap(), 3000);
  }
}
void bootstrap();
