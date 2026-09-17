import WebSocket from "ws";
import type { PublicMachineIdentity } from "./machineIdentity.js";
import { PiRegistry, PiRegistryError } from "./piRegistry.js";
import type { SessionAccess } from "./types.js";

const PROTOCOL_VERSION = 0;

interface ControlRequest {
  protocolVersion: 0;
  type: "control.request";
  requestId: string;
  machineId: string;
  payload: Record<string, unknown>;
}

interface ControlResponse {
  protocolVersion: 0;
  type: "control.response";
  requestId: string;
  machineId: string;
  ok: boolean;
  payload?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
  };
}

export interface RelayHostClientOptions {
  url: string;
  token: string;
  machine: PublicMachineIdentity;
  registry?: PiRegistry;
  minReconnectMs?: number;
  maxReconnectMs?: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseRequest(text: string): ControlRequest | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return null;
  }
  const frame = asRecord(decoded);
  if (!frame
    || frame.protocolVersion !== PROTOCOL_VERSION
    || frame.type !== "control.request"
    || typeof frame.requestId !== "string"
    || typeof frame.machineId !== "string") {
    return null;
  }
  const payload = asRecord(frame.payload);
  if (!payload) return null;
  return {
    protocolVersion: 0,
    type: "control.request",
    requestId: frame.requestId,
    machineId: frame.machineId,
    payload,
  };
}

function parseAccess(value: unknown): SessionAccess | null {
  return value === "view" || value === "control" ? value : null;
}

function errorCode(error: unknown): string {
  if (error instanceof PiRegistryError) return error.code;
  if (error instanceof TypeError) return "invalid_request";
  return "internal_error";
}

function safeMessage(error: unknown): string {
  if (error instanceof PiRegistryError || error instanceof TypeError) return error.message;
  return "The host could not complete the request.";
}

export class RelayHostClient {
  readonly #registry: PiRegistry;
  readonly #minReconnectMs: number;
  readonly #maxReconnectMs: number;
  #socket: WebSocket | null = null;
  #stopped = true;
  #reconnectMs: number;
  #reconnectTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: RelayHostClientOptions) {
    this.#registry = options.registry ?? new PiRegistry();
    this.#minReconnectMs = options.minReconnectMs ?? 1_000;
    this.#maxReconnectMs = options.maxReconnectMs ?? 30_000;
    this.#reconnectMs = this.#minReconnectMs;
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.#socket?.close(1000, "host shutting down");
    this.#socket = null;
  }

  #connect(): void {
    if (this.#stopped) return;

    const ws = new WebSocket(this.options.url, {
      headers: {
        authorization: `Bearer ${this.options.token}`,
      },
    });
    this.#socket = ws;

    ws.on("open", () => {
      this.#reconnectMs = this.#minReconnectMs;
      ws.send(JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        type: "host.hello",
        machine: {
          id: this.options.machine.id,
          name: this.options.machine.name,
          platform: this.options.machine.platform,
          capabilities: ["sessions.list", "sessions.link"],
        },
      }));
      console.log(`Pi Remote host connected as ${this.options.machine.name} (${this.options.machine.id})`);
    });

    ws.on("message", raw => {
      const request = parseRequest(raw.toString("utf8"));
      if (!request || request.machineId !== this.options.machine.id) return;
      void this.#handleRequest(ws, request);
    });

    ws.on("error", error => {
      console.error("Pi Remote relay connection error:", error.message);
    });

    ws.on("close", () => {
      if (this.#socket === ws) this.#socket = null;
      this.#scheduleReconnect();
    });
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#reconnectTimer) return;
    const delay = this.#reconnectMs;
    this.#reconnectMs = Math.min(this.#maxReconnectMs, Math.max(delay + 1, delay * 2));
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect();
    }, delay);
    this.#reconnectTimer.unref();
  }

  async #handleRequest(ws: WebSocket, request: ControlRequest): Promise<void> {
    let response: ControlResponse;

    try {
      const op = request.payload.op;
      if (op === "sessions.list") {
        const sessions = await this.#registry.listSessions();
        response = {
          protocolVersion: 0,
          type: "control.response",
          requestId: request.requestId,
          machineId: request.machineId,
          ok: true,
          payload: { op, sessions },
        };
      } else if (op === "sessions.link") {
        const instanceId = request.payload.instanceId;
        const generation = request.payload.generation;
        const access = parseAccess(request.payload.access);
        if (typeof instanceId !== "string"
          || typeof generation !== "number"
          || !Number.isInteger(generation)
          || generation < 1
          || !access) {
          throw new TypeError("sessions.link requires instanceId, positive generation, and access");
        }

        const link = await this.#registry.createLink(instanceId, generation, access);
        response = {
          protocolVersion: 0,
          type: "control.response",
          requestId: request.requestId,
          machineId: request.machineId,
          ok: true,
          payload: { op, ...link },
        };
      } else {
        throw new TypeError("unsupported control operation");
      }
    } catch (error) {
      response = {
        protocolVersion: 0,
        type: "control.response",
        requestId: request.requestId,
        machineId: request.machineId,
        ok: false,
        error: {
          code: errorCode(error),
          message: safeMessage(error),
        },
      };
    }

    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(response));
  }
}
