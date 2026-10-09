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
let synchronizing = false;

function setConnection(message, kind = "") {
  connection.textContent = message;
  connection.className = "connection " + kind;
}
function setActivity(message) { activity.textContent = message; }
async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    cache: "no-store",
    ...options
  });
  let value;
  try { value = await response.json(); } catch { value = {}; }
  if (response.status === 401 && url !== "/api/login") showLogin();
  if (!response.ok) throw new Error(value.error || value.status || "HTTP " + response.status);
  return value;
}
function showLogin() {
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
async function syncState(expectedEpoch = epoch) {
  if (!current || expectedEpoch !== epoch || synchronizing) return;
  synchronizing = true;
  try {
    const data = await api("/api/sessions/" + encodeURIComponent(current.id) + "/state");
    if (expectedEpoch !== epoch) return;
    renderMessages(data.messages);
    setActivity(data.busy ? "Pi 正在工作" : "会话已同步");
    setConnection("已连接 · 会话状态已同步", "good");
  } catch (err) {
    if (expectedEpoch === epoch) setConnection("同步失败，等待重新连接：" + err.message, "bad");
  } finally { synchronizing = false; }
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
      appendLive(update.delta);
    }
  }
  if (type === "agent_end" || type === "turn_end" || type === "message_end") {
    setActivity("本轮结束");
    scheduleSync(type === "message_end" ? 350 : 0);
  }
}
function attachStream(id, cursor, expectedEpoch) {
  if (stream) stream.close();
  stream = new EventSource("/api/sessions/" + encodeURIComponent(id) + "/events?since=" + cursor);
  stream.addEventListener("rpc", event => {
    if (expectedEpoch !== epoch) return;
    try { processRpc(JSON.parse(event.data)); } catch {}
  });
  stream.addEventListener("reset", () => {
    if (expectedEpoch === epoch) scheduleSync(120);
  });
  stream.onopen = () => {
    if (expectedEpoch !== epoch) return;
    setConnection("实时事件流已连接", "good");
    // A fresh authoritative snapshot after reconnect is safer than trusting an old UI cache.
    scheduleSync(180);
  };
  stream.onerror = () => {
    if (expectedEpoch !== epoch) return;
    setConnection("连接暂时中断，正在自动恢复…", "bad");
  };
}
async function openSession(session) {
  epoch++;
  const thisEpoch = epoch;
  current = session;
  pendingCommand = null;
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
    renderMessages(data.messages);
    setActivity(data.busy ? "Pi 正在运行" : "准备就绪");
    attachStream(session.id, data.cursor, thisEpoch);
  } catch (err) {
    if (thisEpoch === epoch) setConnection("无法连接会话：" + err.message, "bad");
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
    await loadSessions();
  } catch (err) {
    $("loginError").textContent = "连接失败：" + err.message;
  }
});
$("composer").addEventListener("submit", async event => {
  event.preventDefault();
  if (!current) return;
  const message = promptBox.value;
  if (!message.trim()) return;
  if (!pendingCommand || pendingCommand.message !== message || pendingCommand.sessionId !== current.id) {
    pendingCommand = { id: crypto.randomUUID(), message, sessionId: current.id };
  }
  $("send").disabled = true;
  setActivity("提交命令中…");
  try {
    const result = await api("/api/sessions/" + encodeURIComponent(current.id) + "/commands", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "prompt", message, commandId: pendingCommand.id })
    });
    if (result.status === "unknown") {
      setActivity("命令状态未确认；再次发送将查询同一命令 ID，不会重复执行");
      return;
    }
    promptBox.value = "";
    pendingCommand = null;
    setActivity("命令已接收，等待 Pi 输出…");
    scheduleSync(400);
  } catch (err) {
    setActivity("发送结果未知；请确认会话状态，重试相同文本不会重复提交");
    setConnection("命令状态：" + err.message, "bad");
  } finally { $("send").disabled = false; }
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
window.addEventListener("online", () => { if (current) scheduleSync(0); });
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && current) scheduleSync(0);
});
async function bootstrap() {
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
  try {
    await api("/api/auth");
    showApp();
    await loadSessions();
  } catch { showLogin(); }
}
void bootstrap();
