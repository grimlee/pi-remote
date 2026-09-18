import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { access, readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { constants as fsConstants } from "node:fs";
import {
  decryptRpcPayload,
  encryptRpcPayload,
  type RpcRelayFrame,
} from "./rpcCrypto.js";
import type { RemoteSession, SessionAccess, SessionLink } from "./types.js";

export class PiRegistryError extends Error {
  constructor(
    readonly code:
      | "invalid_response"
      | "pi_command_failed"
      | "stale_generation"
      | "unsupported_access"
      | "session_not_found"
      | "invalid_rpc_frame",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PiRegistryError";
  }
}

interface SessionRecord {
  instanceId: string;
  generation: number;
  sessionId: string;
  path: string;
  cwd: string;
  name: string | null;
  model: string | null;
  startedAt: string;
}

interface RpcChannel {
  channelId: string;
  machineId: string;
  deviceId: string;
  key: Buffer;
  process: ChildProcessWithoutNullStreams;
  lastClientSeq: number;
  nextHostSeq: number;
  stdoutBuffer: string;
  stdoutDecoder: StringDecoder;
}

export interface PiRegistryOptions {
  executable?: string;
  sessionDir?: string;
  maxSessions?: number;
  idleTimeoutMs?: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function messageText(value: unknown): string | null {
  const message = asRecord(value);
  if (!message) return null;
  const content = message.content;
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const item of content) {
    const record = asRecord(item);
    if (record?.type === "text" && typeof record.text === "string") {
      parts.push(record.text);
    }
  }
  const text = parts.join("\n").trim();
  return text || null;
}

async function collectSessionFiles(root: string, output: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }

  await Promise.all(entries.map(async entry => {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await collectSessionFiles(full, output);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      output.push(full);
    }
  }));
}

async function parseSessionFile(file: string, generation: number): Promise<SessionRecord | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return null;
  }

  let header: Record<string, unknown> | null = null;
  let name: string | null = null;
  let model: string | null = null;
  let firstMessage: string | null = null;

  for (const line of text.split("\n")) {
    if (!line) continue;
    let decoded: unknown;
    try {
      decoded = JSON.parse(line);
    } catch {
      continue;
    }
    const record = asRecord(decoded);
    if (!record) continue;

    if (record.type === "session" && !header) {
      header = record;
      continue;
    }
    if (record.type === "session_info" && typeof record.name === "string" && record.name.trim()) {
      name = record.name.trim();
      continue;
    }
    if (record.type === "model_change"
      && typeof record.provider === "string"
      && typeof record.modelId === "string") {
      model = `${record.provider}/${record.modelId}`;
      continue;
    }
    if (record.type === "message") {
      const message = asRecord(record.message);
      if (!message) continue;
      if (!firstMessage && message.role === "user") {
        firstMessage = messageText(message);
      }
      if (message.role === "assistant"
        && typeof message.provider === "string"
        && typeof message.model === "string") {
        model = `${message.provider}/${message.model}`;
      }
    }
  }

  if (!header
    || typeof header.id !== "string"
    || typeof header.cwd !== "string"
    || typeof header.timestamp !== "string") {
    return null;
  }

  return {
    instanceId: header.id,
    generation,
    sessionId: header.id,
    path: file,
    cwd: header.cwd,
    name: name ?? firstMessage?.slice(0, 96) ?? null,
    model,
    startedAt: header.timestamp,
  };
}

export class PiRegistry {
  readonly #executable: string;
  readonly #sessionDir: string;
  readonly #maxSessions: number;
  readonly #idleTimeoutMs: number;
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #channels = new Map<string, RpcChannel>();
  readonly #idleTimers = new Map<string, NodeJS.Timeout>();
  #outbound: ((frame: RpcRelayFrame) => void) | null = null;

  constructor(options: PiRegistryOptions = {}) {
    this.#executable = options.executable ?? process.env.PI_REMOTE_PI_COMMAND ?? "pi";
    this.#sessionDir = options.sessionDir
      ?? process.env.PI_CODING_AGENT_SESSION_DIR
      ?? path.join(os.homedir(), ".pi", "agent", "sessions");
    this.#maxSessions = options.maxSessions ?? 100;
    this.#idleTimeoutMs = options.idleTimeoutMs ?? 30 * 60_000;
  }

  setOutboundFrameHandler(handler: ((frame: RpcRelayFrame) => void) | null): void {
    this.#outbound = handler;
  }

  async listSessions(): Promise<RemoteSession[]> {
    const files: string[] = [];
    await collectSessionFiles(this.#sessionDir, files);

    const withStats = await Promise.all(files.map(async file => {
      try {
        return { file, info: await stat(file) };
      } catch {
        return null;
      }
    }));

    const recent = withStats
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .sort((a, b) => b.info.mtimeMs - a.info.mtimeMs)
      .slice(0, this.#maxSessions);

    const parsed = await Promise.all(recent.map(item =>
      parseSessionFile(item.file, Math.max(1, Math.floor(item.info.mtimeMs))),
    ));

    this.#sessions.clear();
    const result: RemoteSession[] = [];
    for (const session of parsed) {
      if (!session) continue;
      this.#sessions.set(session.instanceId, session);
      result.push({
        instanceId: session.instanceId,
        generation: session.generation,
        sessionId: session.sessionId,
        name: session.name,
        cwd: session.cwd,
        model: session.model,
        startedAt: session.startedAt,
        participantCount: 0,
        relayConnected: true,
        inputRequired: false,
        access: "control",
      });
    }
    return result;
  }

  async createLink(
    instanceId: string,
    generation: number,
    accessLevel: SessionAccess,
    context?: { machineId: string; deviceId: string },
  ): Promise<SessionLink> {
    if (!instanceId) throw new TypeError("instanceId is required");
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw new TypeError("generation must be a positive integer");
    }
    if (accessLevel !== "control") {
      throw new PiRegistryError("unsupported_access", "Pi RPC sessions currently require control access");
    }
    if (!context) {
      throw new TypeError("Pi RPC channel context is required");
    }

    await this.listSessions();
    const session = this.#sessions.get(instanceId);
    if (!session) {
      throw new PiRegistryError("session_not_found", "The selected Pi session no longer exists");
    }
    if (session.generation !== generation) {
      throw new PiRegistryError(
        "stale_generation",
        "The selected Pi session changed before it could be opened",
      );
    }

    if (this.#executable.includes(path.sep)) {
      try {
        await access(this.#executable, fsConstants.X_OK);
      } catch (error) {
        throw new PiRegistryError("pi_command_failed", "Pi executable is not available", { cause: error });
      }
    }

    const channelId = "rpc_" + randomUUID().replaceAll("-", "");
    const key = randomBytes(32);
    const cwd = await this.#usableCwd(session.cwd);

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(
        this.#executable,
        ["--session", session.path, "--mode", "rpc"],
        {
          cwd,
          env: process.env,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
    } catch (error) {
      throw new PiRegistryError("pi_command_failed", "Could not start Pi RPC", { cause: error });
    }

    const channel: RpcChannel = {
      channelId,
      machineId: context.machineId,
      deviceId: context.deviceId,
      key,
      process: child,
      lastClientSeq: 0,
      nextHostSeq: 1,
      stdoutBuffer: "",
      stdoutDecoder: new StringDecoder("utf8"),
    };
    this.#channels.set(channelId, channel);
    this.#armIdleTimer(channel);

    child.stdout.on("data", chunk => this.#consumeStdout(channel, chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", value => {
      const line = String(value).trim();
      if (line) console.error(`Pi RPC stderr [${channelId}]: ${line}`);
    });
    child.on("error", error => {
      console.error(`Pi RPC process error [${channelId}]:`, error.message);
      this.#sendHostPayload(channel, {
        type: "piremote.channel_closed",
        error: "Pi RPC process failed to start",
      });
      this.#deleteChannel(channelId);
    });
    child.on("exit", (code, signal) => {
      if (this.#channels.get(channelId) !== channel) return;
      const tail = channel.stdoutBuffer + channel.stdoutDecoder.end();
      if (tail.trim()) this.#emitPiLine(channel, tail);
      this.#sendHostPayload(channel, {
        type: "piremote.channel_closed",
        code,
        signal,
      });
      this.#deleteChannel(channelId);
    });

    const capability = JSON.stringify({
      version: 1,
      protocol: "piremote-pi-rpc-v1",
      channelId,
      key: key.toString("base64url"),
    });

    return {
      instanceId,
      generation,
      access: accessLevel,
      collabUrl: capability,
    };
  }

  handleRpcFrame(frame: RpcRelayFrame): void {
    const channel = this.#channels.get(frame.channelId);
    if (!channel
      || frame.direction !== "client"
      || frame.machineId !== channel.machineId
      || frame.deviceId !== channel.deviceId
      || frame.seq !== channel.lastClientSeq + 1) {
      return;
    }

    let plaintext: Buffer;
    try {
      plaintext = decryptRpcPayload(frame, channel.key);
    } catch {
      return;
    }

    let value: unknown;
    try {
      value = JSON.parse(plaintext.toString("utf8"));
    } catch {
      return;
    }
    const record = asRecord(value);
    if (!record) return;

    channel.lastClientSeq = frame.seq;
    this.#armIdleTimer(channel);

    if (record.type === "piremote.close") {
      this.#terminateChannel(channel.channelId);
      return;
    }

    if (!channel.process.stdin.destroyed) {
      channel.process.stdin.write(JSON.stringify(record) + "\n");
    }
  }

  stop(): void {
    for (const channelId of [...this.#channels.keys()]) {
      this.#terminateChannel(channelId);
    }
  }

  async #usableCwd(cwd: string): Promise<string> {
    try {
      const info = await stat(cwd);
      if (info.isDirectory()) return cwd;
    } catch {
      // Fall through.
    }
    return process.cwd();
  }

  #consumeStdout(channel: RpcChannel, chunk: Buffer): void {
    channel.stdoutBuffer += channel.stdoutDecoder.write(chunk);
    while (true) {
      const index = channel.stdoutBuffer.indexOf("\n");
      if (index < 0) break;
      let line = channel.stdoutBuffer.slice(0, index);
      channel.stdoutBuffer = channel.stdoutBuffer.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.trim()) this.#emitPiLine(channel, line);
    }
  }

  #emitPiLine(channel: RpcChannel, line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    if (!asRecord(value)) return;
    this.#sendHostPayload(channel, value as Record<string, unknown>);
  }

  #sendHostPayload(channel: RpcChannel, value: Record<string, unknown>): void {
    const outbound = this.#outbound;
    if (!outbound) return;

    const frame = encryptRpcPayload(
      {
        machineId: channel.machineId,
        deviceId: channel.deviceId,
        channelId: channel.channelId,
        direction: "host",
        seq: channel.nextHostSeq++,
      },
      Buffer.from(JSON.stringify(value), "utf8"),
      channel.key,
    );
    outbound(frame);
    this.#armIdleTimer(channel);
  }

  #armIdleTimer(channel: RpcChannel): void {
    const previous = this.#idleTimers.get(channel.channelId);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.#terminateChannel(channel.channelId);
    }, this.#idleTimeoutMs);
    timer.unref();
    this.#idleTimers.set(channel.channelId, timer);
  }

  #terminateChannel(channelId: string): void {
    const channel = this.#channels.get(channelId);
    if (!channel) return;
    this.#deleteChannel(channelId);
    if (!channel.process.stdin.destroyed) channel.process.stdin.end();
    if (!channel.process.killed) channel.process.kill("SIGTERM");
    const killTimer = setTimeout(() => {
      if (channel.process.exitCode === null) {
        channel.process.kill("SIGKILL");
      }
    }, 2_000);
    killTimer.unref();
  }

  #deleteChannel(channelId: string): void {
    this.#channels.delete(channelId);
    const timer = this.#idleTimers.get(channelId);
    if (timer) clearTimeout(timer);
    this.#idleTimers.delete(channelId);
  }
}
