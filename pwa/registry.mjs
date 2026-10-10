import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import { publicState } from "./control.mjs";
import path from "node:path";
import os from "node:os";

export const DEFAULT_SESSION_DIR = process.env.PI_CODING_AGENT_SESSION_DIR
  || path.join(os.homedir(), ".pi", "agent", "sessions");

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter(item => item && item.type === "text" && typeof item.text === "string")
    .map(item => item.text).join("\n");
}

async function sessionFiles(root) {
  const pending = [root];
  const files = [];
  let visited = 0;
  while (pending.length && visited < 5000 && files.length < 10000) {
    const dir = pending.pop();
    visited++;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "EACCES") continue;
      throw error;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(full);
    }
  }
  return files;
}

async function parseSession(file, mtime) {
  let header = null;
  let name = null;
  let firstUser = null;
  let model = null;
  const input = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try { event = record(JSON.parse(line)); } catch { continue; }
      if (!event) continue;
      if (event.type === "session" && !header) header = event;
      if (event.type === "session_info" && typeof event.name === "string" && event.name.trim()) {
        name = event.name.trim();
      }
      if (event.type === "model_change" && typeof event.provider === "string" && typeof event.modelId === "string") {
        model = event.provider + "/" + event.modelId;
      }
      if (event.type === "message") {
        const message = record(event.message);
        if (message?.role === "user" && firstUser === null) {
          firstUser = contentText(message.content).trim().slice(0, 96);
        }
        if (message?.role === "assistant" && typeof message.provider === "string" && typeof message.model === "string") {
          model = message.provider + "/" + message.model;
        }
      }
    }
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  } finally {
    input.destroy();
  }
  if (!header || typeof header.id !== "string" || !header.id
    || typeof header.cwd !== "string" || typeof header.timestamp !== "string") return null;
  const started = Date.parse(header.timestamp);
  return {
    id: header.id,
    generation: Number.isSafeInteger(started) && started > 0 ? started : 1,
    cwd: header.cwd,
    name: name || firstUser || "Untitled session",
    model,
    updatedAt: mtime.toISOString(),
    startedAt: header.timestamp,
    file
  };
}

export async function discoverSessions(root = DEFAULT_SESSION_DIR, limit = 100) {
  const files = await sessionFiles(root);
  const stats = await Promise.all(files.map(async file => {
    try { const s = await stat(file); return { file, s }; } catch { return null; }
  }));
  const recent = stats.filter(Boolean).sort((a, b) => b.s.mtimeMs - a.s.mtimeMs).slice(0, limit);
  const sessions = [];
  // Avoid opening 100 large JSONL files at the same time.
  for (const item of recent) {
    const parsed = await parseSession(item.file, item.s.mtime);
    if (parsed) sessions.push(parsed);
  }
  return sessions;
}

export function publicSession(session) {
  const { file, ...safe } = session;
  return safe;
}

export class PiRunner {
  constructor(session, options = {}) {
    this.session = session;
    this.executable = options.executable || process.env.PI_REMOTE_PWA_PI_COMMAND || "pi";
    this.sessionDir = options.sessionDir;
    this.extraArgs = options.extraArgs || [];
    this.pending = new Map();
    this.listeners = new Set();
    this.events = [];
    this.eventBytes = 0;
    this.seq = 0;
    this.busy = false;
    this.liveMessage = null;
    this.tools = new Map();
    this.uiRequests = new Map();
    this.uiTimers = new Map();
    this.notice = null;
    this.dead = false;
    this.lastActive = Date.now();
    this.buffer = "";
    this.decoder = new StringDecoder("utf8");
    this.child = null;
    this.onClosed = options.onClosed || (() => {});
  }

  async start() {
    if (this.child) return;
    let cwd = process.cwd();
    try {
      if ((await stat(this.session.cwd)).isDirectory()) cwd = this.session.cwd;
    } catch {}
    const args=["--mode","rpc",...this.extraArgs];
    if(this.session.file && await stat(this.session.file).then(()=>true).catch(()=>false)) args.push('--session',this.session.file);
    else if(this.session.id) {
      args.push('--session-id',this.session.id);
      if(this.session.name) args.push('--name',this.session.name);
      if(this.session.model) {const split=this.session.model.indexOf('/');if(split>0)args.push('--provider',this.session.model.slice(0,split),'--model',this.session.model.slice(split+1));}
      if(this.session.thinkingLevel) args.push('--thinking',this.session.thinkingLevel);
    }
    if(this.sessionDir) args.push('--session-dir',this.sessionDir);
    this.child = spawn(this.executable, args, {
      cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"], shell: false
    });
    this.child.stdout.on("data", bytes => this.consume(bytes));
    this.child.stderr.on("data", bytes => {
      // Do not log tool output, credentials, or conversation content.
      if (process.env.PI_REMOTE_PWA_TRACE === "1") console.error("Pi RPC stderr bytes:", bytes.length);
    });
    this.child.on("error", error => this.stopWithError(error));
    this.child.on("exit", (code, signal) => this.stopWithError(new Error("Pi RPC exited: " + (code ?? signal))));
  }

  consume(bytes) {
    this.buffer += this.decoder.write(bytes);
    let next;
    while ((next = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, next).trim();
      this.buffer = this.buffer.slice(next + 1);
      if (!line) continue;
      let message;
      try { message = record(JSON.parse(line)); } catch { continue; }
      if (!message) continue;
      if (message.type === "response" && message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        pending.resolve(message);
      } else if (message.type !== "response") {
        if (message.type === "agent_start") this.busy = true;
        if ((message.type === "agent_end" && !message.willRetry) || message.type === "agent_settled") this.busy = false;
        if (message.type === "message_start" || message.type === "message_update") {
          if (message.message?.role === "assistant") this.liveMessage = structuredClone(message.message);
          else if (message.type === "message_update") this.applyTextUpdate(message.assistantMessageEvent);
        }
        if (message.type === "message_end" || message.type === "agent_settled") this.liveMessage = null;
        if(message.type==='extension_ui_request') {
          if(['confirm','input','select','editor'].includes(message.method) && typeof message.id==='string') {
            const request={...message,receivedAt:Date.now(),expiresAt:typeof message.timeout==='number'?Date.now()+message.timeout:null};
            this.uiRequests.set(message.id,request);
            if(request.expiresAt){const timer=setTimeout(()=>{this.uiRequests.delete(message.id);this.uiTimers.delete(message.id);this.publish('rpc',{type:'ui_expired',id:message.id});},Math.max(0,message.timeout));this.uiTimers.set(message.id,timer);}
          }else if(message.method==='notify') this.notice={message:message.message,notifyType:message.notifyType};
        }
        if (message.type === 'tool_execution_start') {
          this.tools.set(message.toolCallId,{toolCallId:message.toolCallId,toolName:message.toolName,status:'运行中'});
          while(this.tools.size>100) this.tools.delete(this.tools.keys().next().value);
        }
        if (message.type === 'tool_execution_end') this.tools.set(message.toolCallId,{toolCallId:message.toolCallId,toolName:message.toolName,status:message.isError?'失败':'成功'});
        this.publish("rpc", message);
      }
    }
  }

  applyTextUpdate(update) {
    if (!update || !Number.isSafeInteger(update.contentIndex ?? 0)) return;
    if (!this.liveMessage) this.liveMessage = { role: "assistant", content: [] };
    const index=update.contentIndex ?? 0; if(index<0 || index>10000) return;
    const blocks=this.liveMessage.content; if(!Array.isArray(blocks)) return;
    const family=update.type?.split('_')[0];
    if (family==='text' || family==='thinking') {
      const key=family==='text'?'text':'thinking';
      if(blocks[index]?.type!==family) blocks[index]={type:family,[key]:''};
      if(update.type.endsWith('_delta') && typeof update.delta==='string') blocks[index][key]+=update.delta;
      if(update.type.endsWith('_end') && typeof update.content==='string') blocks[index][key]=update.content;
    } else if(family==='toolcall' && update.type==='toolcall_end' && update.toolCall) blocks[index]=structuredClone(update.toolCall);
  }

  publish(type, data) {
    const entry = { id: ++this.seq, type, data };
    const bytes = Buffer.byteLength(JSON.stringify(entry));
    this.events.push(entry);
    this.eventBytes += bytes;
    while (this.events.length > 1200 || this.eventBytes > 2 * 1024 * 1024) {
      const removed = this.events.shift();
      if (!removed) break;
      this.eventBytes -= Buffer.byteLength(JSON.stringify(removed));
    }
    for (const send of this.listeners) send(entry);
  }

  subscribe(send, since) {
    // Replay happens synchronously before subscribing, avoiding the replay/live race.
    const first = this.events[0]?.id ?? (this.seq + 1);
    if (since < first - 1 || since > this.seq) {
      send({ id: this.seq, type: "reset", data: { reason: "replay_unavailable" } });
    } else {
      for (const event of this.events) if (event.id > since) send(event);
    }
    this.listeners.add(send);
    return () => this.listeners.delete(send);
  }

  request(type, values = {}, timeoutMs = 20000) {
    if (this.dead || !this.child || !this.child.stdin.writable) {
      return Promise.reject(new Error("Pi RPC is not connected"));
    }
    this.lastActive = Date.now();
    const id = "pwa_" + randomUUID();
    const message = JSON.stringify({ id, type, ...values }) + "\n";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Pi RPC request timed out: " + type));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(message, error => {
        if (error && this.pending.has(id)) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        }
      });
    }).then(response => {
      if (response.success === false) throw new Error(response.error || "Pi RPC " + type + " rejected");
      return response.data;
    });
  }

  async snapshot() {
    const state = await this.request("get_state", {}, 30000);
    // get_state covers retries/tool loops that can continue after turn_end.
    this.busy = !!(state?.isStreaming || state?.isCompacting || state?.isRetrying);
    const data = await this.request("get_messages", {}, 30000);
    return {
      state: publicState(state || {}),
      session: {id:this.session.id,generation:this.session.generation},
      messages: Array.isArray(data?.messages) ? data.messages : (Array.isArray(data) ? data : []),
      cursor: this.seq,
      busy: this.busy,
      liveMessage: this.liveMessage,
      tools: [...this.tools.values()],
      uiRequests:[...this.uiRequests.values()],
      notice:this.notice
    };
  }

  async answerUI(values) {
    const request=this.uiRequests.get(values.id);
    if(!request || (request.expiresAt && request.expiresAt<=Date.now())) throw Object.assign(new Error('request_expired'),{status:409,code:'request_expired'});
    if(values.cancelled!==true) {
      if(request.method==='confirm') {if(typeof values.confirmed!=='boolean')throw Object.assign(new Error('invalid_confirmation'),{status:400,code:'invalid_confirmation'});}
      else if(typeof values.value!=='string'||values.value.length>20000 || (request.method==='select'&&!request.options?.includes(values.value))) throw Object.assign(new Error('invalid_ui_value'),{status:400,code:'invalid_ui_value'});
    }
    const response={type:'extension_ui_response',id:values.id,...(values.cancelled===true?{cancelled:true}:request.method==='confirm'?{confirmed:values.confirmed}:{value:values.value})};
    await new Promise((resolve,reject)=>this.child.stdin.write(JSON.stringify(response)+'\n',err=>err?reject(err):resolve()));
    this.uiRequests.delete(values.id);clearTimeout(this.uiTimers.get(values.id));this.uiTimers.delete(values.id);
  }

  stopWithError(error) {
    if (this.dead) return;
    this.dead = true;
    for(const timer of this.uiTimers.values())clearTimeout(timer);this.uiTimers.clear();this.uiRequests.clear();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.publish("reset", { reason: "rpc_exited" });
    this.onClosed(this);
  }

  stop() {
    if (this.child && !this.child.killed) this.child.kill("SIGTERM");
    this.stopWithError(new Error("Pi RPC stopped"));
  }
}
