import { RecoveryMemory, messageFingerprint } from "./recovery.js";
const $ = id => document.getElementById(id);
const loginView = $("loginView");
const appView = $("appView");
const sidebar = $("sidebar");
const sessionsView = $("sessions");
const messagesView = $("messages");
const promptBox = $("prompt");
const connection = $("connection");
const activity = $("activity");
let sessions = [];
let current = null;
let stream = null;
let epoch = 0;
let liveText = "";
let liveNode = null;
let syncTimer = null;
let pendingCommand = null;
let synchronizing = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
let submitting = false;
let streamWatchdog = null;
let pollTimer = null;
let realtimeConnected = false;
function clearRealtimeTimers() {
  clearTimeout(streamWatchdog);
  clearTimeout(pollTimer);
  streamWatchdog = pollTimer = null;
  realtimeConnected = false;
}
function startPolling(expectedEpoch) {
  clearTimeout(pollTimer);
  setConnection("会话已连接 · 实时流暂不可用，自动同步中", "good");
  const poll = async () => {
    if (expectedEpoch !== epoch || realtimeConnected || !current) return;
    await syncState(expectedEpoch);
    if (expectedEpoch === epoch && !realtimeConnected && current) pollTimer = setTimeout(poll, 3000);
  };
  pollTimer = setTimeout(poll, 0);
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
  const deadline = setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetch(url, {
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
      ...options
    });
    let value;
    try { value = await response.json(); } catch { value = {}; }
    if (response.status === 401 && url !== "/api/login") showLogin();
    if (!response.ok) throw Object.assign(new Error(value.error || value.status || "HTTP " + response.status), { status: response.status });
    return value;
  } finally { clearTimeout(deadline); }
}
function showLogin() {
  epoch++;
  clearTimeout(reconnectTimer);
  clearTimeout(syncTimer);
  clearRealtimeTimers();
  current = null;
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
function renderSessions() {
  sessionsView.replaceChildren();
  const groups = new Map();
  for (const s of sessions) {
    if (!groups.has(s.cwd)) groups.set(s.cwd, []);
    groups.get(s.cwd).push(s);
  }
  for (const [cwd, items] of groups) {
    const heading = document.createElement("div");
    heading.className = "workspace";
    heading.textContent = cwd;
    sessionsView.append(heading);
    for (const session of items) {
      const button = document.createElement("button");
      button.className = "session" + (current?.id === session.id ? " active" : "");
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = sessionLabel(session);
      const meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = (session.model || "Pi") + " · " + relativeDate(session.updatedAt);
      button.append(name, meta);
      button.addEventListener("click", () => void openSession(session));
      sessionsView.append(button);
    }
  }
  if (!sessions.length) sessionsView.textContent = "没有发现 Pi JSONL 会话。先在 Host 上使用 Pi 创建一个会话。";
}
async function loadSessions() {
  try {
    const data = await api("/api/sessions");
    sessions = data.sessions || [];
    renderSessions();
    if (!current) setConnection("Host 已连接 · 等待选择会话", "good");
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
function scrollBottom() { messagesView.scrollTop = messagesView.scrollHeight; }
function makeMessage(role, text) {
  const block = document.createElement("section");
  block.className = "message " + role;
  const label = document.createElement("div");
  label.className = "role";
  label.textContent = role === "user" ? "You" : role === "assistant" ? "Pi" : "Tool";
  const body = document.createElement("div");
  body.className = "content";
  body.textContent = text;
  block.append(label, body);
  return { block, body };
}
function renderMessages(messages) {
  const nearBottom = atBottom();
  const fragment = document.createDocumentFragment();
  for (const message of (messages || []).slice(-160)) {
    const role = message?.role;
    if (role === "assistant" || role === "user") {
      const text = textContentOf(message);
      if (text) fragment.append(makeMessage(role, text).block);
      if (role === "assistant" && message.errorMessage) {
        fragment.append(makeMessage(role, message.stopReason === "aborted" || /aborted/i.test(message.errorMessage)
          ? "已停止" : "Pi 运行失败：" + message.errorMessage).block);
      }
    } else if (role === "toolResult" || role === "tool") {
      const node = document.createElement("div");
      node.className = "tool";
      node.textContent = "工具完成：" + String(message.toolName || message.name || "tool");
      fragment.append(node);
    }
  }
  messagesView.replaceChildren(fragment);
  liveNode = null;
  liveText = "";
  if (nearBottom) scrollBottom();
}
function appendLive(delta) {
  if (!delta || !current) return;
  const nearBottom = atBottom();
  if (!liveNode) {
    const item = makeMessage("assistant", "");
    liveNode = item.body;
    messagesView.append(item.block);
  }
  liveText += delta;
  liveNode.textContent = liveText;
  if (nearBottom) scrollBottom();
}
function renderSnapshot(data) {
  renderMessages(data.messages);
  if (data.busy && data.liveMessage) appendLive(textContentOf(data.liveMessage));
}
async function syncState(expectedEpoch = epoch) {
  if (!current || expectedEpoch !== epoch || synchronizing === expectedEpoch) return;
  synchronizing = expectedEpoch;
  try {
    const data = await api("/api/sessions/" + encodeURIComponent(current.id) + "/state");
    if (expectedEpoch !== epoch) return;
    renderSnapshot(data);
    setActivity(data.busy ? "Pi 正在工作" : "会话已同步");
    setConnection(realtimeConnected ? "已连接 · 会话状态已同步" : "会话已连接 · 自动同步中", "good");
  } catch (err) {
    if (expectedEpoch === epoch) setConnection("同步失败，等待重新连接：" + err.message, "bad");
  } finally { if (synchronizing === expectedEpoch) synchronizing = null; }
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
  if (type === "message_update") {
    const update = payload.assistantMessageEvent;
    if (update?.type === "text_delta" && typeof update.delta === "string") {
      if (payload.message?.role === "assistant") {
        if (!liveNode) appendLive(" ");
        liveText = textContentOf(payload.message);
        liveNode.textContent = liveText;
        if (atBottom()) scrollBottom();
      } else appendLive(update.delta);
    }
  }
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
    startPolling(expectedEpoch);
    retryRecovery(expectedEpoch);
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
async function reconcileCommand(id) {
  const pending = memory.pending(id);
  if (!pending) return;
  try {
    const receipt = await api("/api/commands/" + encodeURIComponent(pending.id));
    if (receipt.status === "accepted") {
      memory.pending(id, null);
      if (current?.id === id) pendingCommand = null;
    } else if (current?.id === id) {
      setActivity("上次命令状态未确认；请检查会话，命令不会自动重发");
    }
  } catch { /* A missing/ambiguous receipt is never automatically re-dispatched. */ }
}
async function recoverSession() {
  if (!current) { if (!appView.hidden) await bootstrap(); return; }
  const session = current;
  const wasPolling = pollTimer !== null;
  const thisEpoch = ++epoch;
  clearTimeout(reconnectTimer);
  clearTimeout(syncTimer);
  clearRealtimeTimers();
  if (stream) { stream.close(); stream = null; }
  try {
    // Restore completed messages and the authoritative in-flight assistant snapshot.
    const data = await api("/api/sessions/" + encodeURIComponent(session.id) + "/state");
    if (thisEpoch !== epoch) return;
    renderSnapshot(data);
    setActivity(data.busy ? "Pi 正在运行" : "会话已恢复");
    setConnection("Pi 会话已连接 · 正在建立实时连接…", "good");
    attachStream(session.id, data.cursor, thisEpoch);
    if (wasPolling) startPolling(thisEpoch);
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
  memory.selected(session.id);
  pendingCommand = memory.pending(session.id);
  clearTimeout(reconnectTimer);
  clearTimeout(syncTimer);
  promptBox.value = "";
  clearRealtimeTimers();
  if (stream) { stream.close(); stream = null; }
  sidebar.classList.remove("open");
  renderSessions();
  $("sessionTitle").textContent = sessionLabel(session);
  $("sessionSub").textContent = session.cwd;
  promptBox.disabled = false;
  $("send").disabled = false;
  $("stop").disabled = false;
  messagesView.textContent = "正在载入会话…";
  setConnection("连接 Pi RPC…");
  try {
    const data = await api("/api/sessions/" + encodeURIComponent(session.id) + "/state");
    if (thisEpoch !== epoch) return;
    renderSnapshot(data);
    setActivity(data.busy ? "Pi 正在运行" : "准备就绪");
    setConnection("Pi 会话已连接 · 正在建立实时连接…", "good");
    attachStream(session.id, data.cursor, thisEpoch);
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
    if (promptBox.value === message) promptBox.value = "";
    pendingCommand = null;
    setActivity("命令已接收，等待 Pi 输出…");
    scheduleSync(400);
  } catch (err) {
    if (current?.id === sessionId) {
      setActivity("发送结果未知；请确认会话状态，重试相同文本不会重复提交");
      setConnection("命令状态：" + err.message, "bad");
    }
  } finally { submitting = false; $("send").disabled = !current; }
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
    await api("/api/sessions/" + encodeURIComponent(current.id) + "/commands", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "abort" })
    });
    setActivity("已发送停止请求");
  } catch (err) { setActivity("停止失败：" + err.message); }
});
$("refreshSessions").addEventListener("click", () => void loadSessions());
$("syncButton").addEventListener("click", () => scheduleSync(0));
$("openSidebar").addEventListener("click", () => sidebar.classList.add("open"));
$("closeSidebar").addEventListener("click", () => sidebar.classList.remove("open"));
window.addEventListener("online", () => void recoverSession());
window.addEventListener("pageshow", event => { if (event.persisted) void recoverSession(); });
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void recoverSession();
});
async function restoreSelection() {
  await loadSessions();
  const selected = sessions.find(s => s.id === memory.selected());
  if (selected) await openSession(selected);
}
async function bootstrap() {
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
  try {
    await api("/api/auth");
    clearTimeout(reconnectTimer);
    showApp();
    await restoreSelection();
  } catch (err) {
    if (err.status === 401) { showLogin(); return; }
    showApp();
    setConnection("主机暂不可达，正在自动恢复…", "bad");
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => void bootstrap(), 3000);
  }
}
void bootstrap();
