import WebSocket from "ws";
import type { AuthorizedDeviceStore } from "./authorizedDevices.js";
import {
  publicMachineIdentity,
  type MachineIdentity,
} from "./machineIdentity.js";
import { PiRegistry, PiRegistryError } from "./piRegistry.js";
import {
  signHostRelayChallenge,
  type RelayAuthChallenge,
} from "./relayAuth.js";
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
  machine: MachineIdentity;
  devices: AuthorizedDeviceStore;
  registry?: PiRegistry;
  minReconnectMs?: number;
  maxReconnectMs?: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseRequest(value: Record<string, unknown>): ControlRequest | null {
  if (value.protocolVersion !== PROTOCOL_VERSION
    || value.type !== "control.request"
    || typeof value.requestId !== "string"
    || typeof value.machineId !== "string") {
    return null;
  }
  const payload = asRecord(value.payload);
  if (!payload) return null;
  return {
    protocolVersion: 0,
    type: "control.request",
    requestId: value.requestId,
    machineId: value.machineId,
    payload,
  };
}

function parseAuthChallenge(value: Record<string, unknown>): RelayAuthChallenge | null {
  if (value.protocolVersion !== 0
    || value.type !== "auth.challenge"
    || value.role !== "host"
    || typeof value.challengeId !== "string"
    || typeof value.nonce !== "string"
    || typeof value.expiresAt !== "string") {
    return null;
  }
  return {
    protocolVersion: 0,
    type: "auth.challenge",
    challengeId: value.challengeId,
    role: "host",
    nonce: value.nonce,
    expiresAt: value.expiresAt,
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
  #authenticated = false;
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
    this.#authenticated = false;
  }

  async refreshAuthorizationSnapshot(): Promise<void> {
    const ws = this.#socket;
    if (!ws || !this.#authenticated || ws.readyState !== WebSocket.OPEN) return;
    await this.#sendAuthorizationSnapshot(ws);
  }

  #connect(): void {
    if (this.#stopped) return;

    const ws = new WebSocket(this.options.url);
    this.#socket = ws;
    this.#authenticated = false;

    ws.on("open", () => {
      this.#reconnectMs = this.#minReconnectMs;
    });

    ws.on("message", raw => {
      const value = asRecord(JSON.parse(raw.toString("utf8")) as unknown);
      if (!value) {
        ws.close(1003, "invalid relay frame");
        return;
      }

      const challenge = parseAuthChallenge(value);
      if (challenge) {
        if (Date.parse(challenge.expiresAt) <= Date.now()) {
          ws.close(4003, "expired relay challenge");
          return;
        }
        ws.send(JSON.stringify(
          signHostRelayChallenge(this.options.machine, challenge),
        ));
        return;
      }

      if (value.protocolVersion === 0 && value.type === "auth.accepted") {
        const principal = asRecord(value.principal);
        if (!principal
          || principal.kind !== "machine"
          || principal.id !== this.options.machine.id
          || principal.signingPublicKey !== this.options.machine.signingPrivateKey.x) {
          ws.close(4003, "relay authenticated unexpected identity");
          return;
        }

        this.#authenticated = true;
        const machine = publicMachineIdentity(this.options.machine);
        ws.send(JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          type: "host.hello",
          machine: {
            id: machine.id,
            name: machine.name,
            platform: machine.platform,
            capabilities: ["sessions.list", "sessions.link"],
            signingPublicKey: machine.signingPublicKey,
            keyAgreementPublicKey: machine.keyAgreementPublicKey,
            fingerprint: machine.fingerprint,
          },
        }));
        void this.#sendAuthorizationSnapshot(ws);
        console.log(
          `Pi Remote host authenticated as ${machine.name} (${machine.id})`,
        );
        return;
      }

      const request = parseRequest(value);
      if (!request
        || !this.#authenticated
        || request.machineId !== this.options.machine.id) {
        return;
      }
      void this.#handleRequest(ws, request);
    });

    ws.on("error", error => {
      console.error("Pi Remote relay connection error:", error.message);
    });

    ws.on("close", () => {
      if (this.#socket === ws) this.#socket = null;
      this.#authenticated = false;
      this.#scheduleReconnect();
    });
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#reconnectTimer) return;
    const delay = this.#reconnectMs;
    this.#reconnectMs = Math.min(
      this.#maxReconnectMs,
      Math.max(delay + 1, delay * 2),
    );
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect();
    }, delay);
    this.#reconnectTimer.unref();
  }

  async #sendAuthorizationSnapshot(ws: WebSocket): Promise<void> {
    const devices = (await this.options.devices.list())
      .filter(device => device.revokedAt === null)
      .map(device => ({
        id: device.id,
        signingPublicKey: device.signingPublicKey,
        keyAgreementPublicKey: device.keyAgreementPublicKey,
        role: device.role,
      }));

    if (ws.readyState !== WebSocket.OPEN || ws !== this.#socket) return;
    ws.send(JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      type: "host.authorization_snapshot",
      machineId: this.options.machine.id,
      devices,
    }));
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
          throw new TypeError(
            "sessions.link requires instanceId, positive generation, and access",
          );
        }

        const link = await this.#registry.createLink(
          instanceId,
          generation,
          access,
        );
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
