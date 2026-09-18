import WebSocket from "ws";
import type { AuthorizedDevice, AuthorizedDeviceStore } from "./authorizedDevices.js";
import { encryptCollabCapability } from "./capabilityCrypto.js";
import { ControlRequestAuthorizer, type SignedControlRequest } from "./controlAuthorization.js";
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

function parseRequest(value: Record<string, unknown>): SignedControlRequest | null {
  if (value.protocolVersion !== PROTOCOL_VERSION
    || value.type !== "control.request"
    || typeof value.requestId !== "string"
    || typeof value.machineId !== "string") {
    return null;
  }

  const payload = asRecord(value.payload);
  const authorization = asRecord(value.authorization);
  if (!payload
    || !authorization
    || typeof authorization.deviceId !== "string"
    || typeof authorization.issuedAtMs !== "number"
    || typeof authorization.signature !== "string") {
    return null;
  }

  if (payload.op === "sessions.list") {
    return {
      protocolVersion: 0,
      type: "control.request",
      requestId: value.requestId,
      machineId: value.machineId,
      payload: { op: "sessions.list" },
      authorization: {
        deviceId: authorization.deviceId,
        issuedAtMs: authorization.issuedAtMs,
        signature: authorization.signature,
      },
    };
  }

  const access = parseAccess(payload.access);
  if (payload.op === "sessions.link"
    && typeof payload.instanceId === "string"
    && typeof payload.generation === "number"
    && Number.isInteger(payload.generation)
    && payload.generation >= 1
    && access) {
    return {
      protocolVersion: 0,
      type: "control.request",
      requestId: value.requestId,
      machineId: value.machineId,
      payload: {
        op: "sessions.link",
        instanceId: payload.instanceId,
        generation: payload.generation,
        access,
      },
      authorization: {
        deviceId: authorization.deviceId,
        issuedAtMs: authorization.issuedAtMs,
        signature: authorization.signature,
      },
    };
  }

  return null;
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
  readonly #authorizer: ControlRequestAuthorizer;
  readonly #minReconnectMs: number;
  readonly #maxReconnectMs: number;
  #socket: WebSocket | null = null;
  #stopped = true;
  #authenticated = false;
  #reconnectMs: number;
  #reconnectTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: RelayHostClientOptions) {
    this.#registry = options.registry ?? new PiRegistry();
    this.#authorizer = new ControlRequestAuthorizer(
      options.devices,
      options.machine.id,
    );
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
      let decoded: unknown;
      try {
        decoded = JSON.parse(raw.toString("utf8"));
      } catch {
        ws.close(1003, "invalid relay JSON");
        return;
      }

      const value = asRecord(decoded);
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
      void this.#authorizeAndHandleRequest(ws, request);
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

  async #authorizeAndHandleRequest(
    ws: WebSocket,
    request: SignedControlRequest,
  ): Promise<void> {
    const authorizedDevice = await this.#authorizer.authorize(request);
    if (!authorizedDevice) {
      const response: ControlResponse = {
        protocolVersion: 0,
        type: "control.response",
        requestId: request.requestId,
        machineId: request.machineId,
        ok: false,
        error: {
          code: "unauthorized",
          message: "Control request signature is invalid, expired, revoked, or replayed.",
        },
      };
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(response));
      return;
    }

    await this.#handleRequest(ws, request, authorizedDevice);
  }

  async #handleRequest(
    ws: WebSocket,
    request: SignedControlRequest,
    authorizedDevice: AuthorizedDevice,
  ): Promise<void> {
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
        const link = await this.#registry.createLink(
          request.payload.instanceId,
          request.payload.generation,
          request.payload.access,
        );

        const currentDevice = await this.options.devices.getActive(
          authorizedDevice.id,
        );
        if (!currentDevice
          || currentDevice.signingPublicKey !== authorizedDevice.signingPublicKey
          || currentDevice.keyAgreementPublicKey !== authorizedDevice.keyAgreementPublicKey) {
          throw new TypeError("device authorization changed before capability issuance");
        }

        const capability = encryptCollabCapability(
          this.options.machine,
          currentDevice,
          request.requestId,
          link,
        );
        response = {
          protocolVersion: 0,
          type: "control.response",
          requestId: request.requestId,
          machineId: request.machineId,
          ok: true,
          payload: {
            op,
            instanceId: link.instanceId,
            generation: link.generation,
            access: link.access,
            capability,
          },
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
