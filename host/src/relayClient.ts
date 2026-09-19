import WebSocket from "ws";
import type { AuthorizedDevice, AuthorizedDeviceStore } from "./authorizedDevices.js";
import { encryptCollabCapability } from "./capabilityCrypto.js";
import { ControlRequestAuthorizer, type SignedControlRequest } from "./controlAuthorization.js";
import {
  publicMachineIdentity,
  type MachineIdentity,
} from "./machineIdentity.js";
import { PairingError, type PairingRequest, type PairingService } from "./pairing.js";
import { PiRegistry, PiRegistryError } from "./piRegistry.js";
import { isRpcRelayFrame, type RpcRelayFrame } from "./rpcCrypto.js";
import {
  signHostRelayChallenge,
  type RelayAuthChallenge,
} from "./relayAuth.js";
import type { SessionAccess } from "./types.js";

const PROTOCOL_VERSION = 0;

interface PairingRelayRequest {
  protocolVersion: 0;
  type: "pairing.request";
  requestId: string;
  machine: {
    id: string;
    signingPublicKey: string;
  };
  pairing: PairingRequest;
}

interface PairingRelayResponse {
  protocolVersion: 0;
  type: "pairing.response";
  requestId: string;
  machineId: string;
  ok: boolean;
  acceptance?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
  };
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
  pairing?: PairingService;
  registry?: PiRegistry;
  minReconnectMs?: number;
  maxReconnectMs?: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}


function parsePairingRequest(
  value: Record<string, unknown>,
): PairingRelayRequest | null {
  if (value.protocolVersion !== 0
    || value.type !== "pairing.request"
    || typeof value.requestId !== "string") {
    return null;
  }

  const machine = asRecord(value.machine);
  const pairing = asRecord(value.pairing);
  const device = pairing ? asRecord(pairing.device) : null;
  if (!machine || !pairing || !device
    || typeof machine.id !== "string"
    || typeof machine.signingPublicKey !== "string"
    || pairing.version !== 1
    || typeof pairing.pairingId !== "string"
    || typeof pairing.machineId !== "string"
    || typeof device.id !== "string"
    || typeof device.name !== "string"
    || typeof device.signingPublicKey !== "string"
    || typeof device.keyAgreementPublicKey !== "string"
    || typeof pairing.proof !== "string"
    || typeof pairing.deviceSignature !== "string") {
    return null;
  }

  return {
    protocolVersion: 0,
    type: "pairing.request",
    requestId: value.requestId,
    machine: {
      id: machine.id,
      signingPublicKey: machine.signingPublicKey,
    },
    pairing: {
      version: 1,
      pairingId: pairing.pairingId,
      machineId: pairing.machineId,
      device: {
        id: device.id,
        name: device.name,
        signingPublicKey: device.signingPublicKey,
        keyAgreementPublicKey: device.keyAgreementPublicKey,
      },
      proof: pairing.proof,
      deviceSignature: pairing.deviceSignature,
    },
  };
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

  if (payload.op === "diagnostics.report") {
    const report = parseDiagnosticsReport(payload.report);
    if (!report) return null;
    return {
      protocolVersion: 0,
      type: "control.request",
      requestId: value.requestId,
      machineId: value.machineId,
      payload: { op: "diagnostics.report", report },
      authorization: {
        deviceId: authorization.deviceId,
        issuedAtMs: authorization.issuedAtMs,
        signature: authorization.signature,
      },
    };
  }

  const access = parseAccess(payload.access);
  const resumeFromHostSeq = payload.resumeFromHostSeq;
  const validResumeCursor = resumeFromHostSeq === undefined
    || (typeof resumeFromHostSeq === "number"
      && Number.isSafeInteger(resumeFromHostSeq)
      && resumeFromHostSeq >= 0);
  if (payload.op === "sessions.link"
    && typeof payload.instanceId === "string"
    && typeof payload.generation === "number"
    && Number.isInteger(payload.generation)
    && payload.generation >= 1
    && access
    && validResumeCursor) {
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
        ...(typeof resumeFromHostSeq === "number"
          ? { resumeFromHostSeq }
          : {}),
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

function isSafeMetric(value: unknown, min: number, max: number): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= min
    && value <= max;
}

function parseDiagnosticsReport(value: unknown) {
  const report = asRecord(value);
  if (!report
    || typeof report.sessionId !== "string"
    || report.sessionId.length > 256
    || !isSafeMetric(report.windowStartedAtMs, 0, Number.MAX_SAFE_INTEGER)
    || !isSafeMetric(report.windowDurationMs, 500, 60_000)
    || !isSafeMetric(report.displayFrames, 0, 10_000)
    || !isSafeMetric(report.slowFrames25Ms, 0, 10_000)
    || !isSafeMetric(report.slowFrames50Ms, 0, 10_000)
    || !isSafeMetric(report.dragFrames, 0, 10_000)
    || !isSafeMetric(report.dragSlowFrames25Ms, 0, 10_000)
    || !isSafeMetric(report.maxFrameGapMs, 0, 10_000)
    || !isSafeMetric(report.snapshotCount, 0, 100_000)
    || !isSafeMetric(report.liveCharacters, 0, 100_000_000)
    || typeof report.isStreaming !== "boolean") {
    return null;
  }
  return {
    sessionId: report.sessionId,
    windowStartedAtMs: report.windowStartedAtMs,
    windowDurationMs: report.windowDurationMs,
    displayFrames: report.displayFrames,
    slowFrames25Ms: report.slowFrames25Ms,
    slowFrames50Ms: report.slowFrames50Ms,
    dragFrames: report.dragFrames,
    dragSlowFrames25Ms: report.dragSlowFrames25Ms,
    maxFrameGapMs: report.maxFrameGapMs,
    snapshotCount: report.snapshotCount,
    liveCharacters: report.liveCharacters,
    isStreaming: report.isStreaming,
  };
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
    this.#registry.setOutboundFrameHandler(frame => this.#sendRpcFrame(frame));
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
    this.#registry.stop();
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
      console.log("Pi Remote Relay socket connected");
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
            capabilities: ["sessions.list", "sessions.link", "pi.rpc"],
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

      if (isRpcRelayFrame(value)) {
        if (!this.#authenticated
          || value.machineId !== this.options.machine.id
          || value.direction !== "client") {
          return;
        }
        this.#registry.handleRpcFrame(value);
        return;
      }

      const pairingRequest = parsePairingRequest(value);
      if (pairingRequest) {
        if (!this.#authenticated) return;
        void this.#handlePairingRequest(ws, pairingRequest);
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

    ws.on("close", (code, reason) => {
      if (this.#socket === ws) this.#socket = null;
      this.#authenticated = false;
      console.log(
        `Pi Remote Relay socket closed code=${code} reason=${reason.toString("utf8") || "-"}`,
      );
      this.#scheduleReconnect();
    });
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#reconnectTimer) return;
    const delay = this.#reconnectMs;
    console.log(`Pi Remote Relay reconnect scheduled in ${delay}ms`);
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

  #sendRpcFrame(frame: RpcRelayFrame): void {
    const ws = this.#socket;
    if (!ws || !this.#authenticated || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(frame));
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


  async #handlePairingRequest(
    ws: WebSocket,
    request: PairingRelayRequest,
  ): Promise<void> {
    let response: PairingRelayResponse;

    try {
      if (!this.options.pairing) {
        throw new PairingError(
          "invalid_request",
          "pairing is not enabled on this host",
        );
      }

      if (request.machine.id !== this.options.machine.id
        || request.machine.signingPublicKey !== this.options.machine.signingPrivateKey.x
        || request.pairing.machineId !== this.options.machine.id) {
        throw new PairingError(
          "invalid_request",
          "pairing request targets a different machine identity",
        );
      }

      const acceptance = await this.options.pairing.accept(request.pairing);
      response = {
        protocolVersion: 0,
        type: "pairing.response",
        requestId: request.requestId,
        machineId: this.options.machine.id,
        ok: true,
        acceptance: acceptance as unknown as Record<string, unknown>,
      };

      await this.#sendAuthorizationSnapshot(ws);
    } catch (error) {
      response = {
        protocolVersion: 0,
        type: "pairing.response",
        requestId: request.requestId,
        machineId: this.options.machine.id,
        ok: false,
        error: {
          code: error instanceof PairingError ? error.code : "internal_error",
          message: error instanceof PairingError
            ? error.message
            : "The host could not complete pairing.",
        },
      };
    }

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(response));
    }
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
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(response));
      }
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
    let replayFrames: RpcRelayFrame[] = [];

    try {
      const op = request.payload.op;
      if (op === "diagnostics.report") {
        const report = request.payload.report;
        console.log(
          "Pi Remote UX"
          + ` device=${authorizedDevice.id}`
          + ` session=${report.sessionId || "-"}`
          + ` window=${report.windowDurationMs}ms`
          + ` frames=${report.displayFrames}`
          + ` slow25=${report.slowFrames25Ms}`
          + ` slow50=${report.slowFrames50Ms}`
          + ` dragFrames=${report.dragFrames}`
          + ` dragSlow25=${report.dragSlowFrames25Ms}`
          + ` maxGap=${report.maxFrameGapMs}ms`
          + ` snapshots=${report.snapshotCount}`
          + ` liveChars=${report.liveCharacters}`
          + ` streaming=${report.isStreaming}`,
        );
        response = {
          protocolVersion: 0,
          type: "control.response",
          requestId: request.requestId,
          machineId: request.machineId,
          ok: true,
          payload: { op },
        };
      } else if (op === "sessions.list") {
        const sessions = await this.#registry.listSessions();
        console.log(
          `Pi Remote sessions.list -> ${sessions.length} persisted sessions for ${authorizedDevice.id}`,
        );
        response = {
          protocolVersion: 0,
          type: "control.response",
          requestId: request.requestId,
          machineId: request.machineId,
          ok: true,
          payload: { op, sessions },
        };
      } else if (op === "sessions.link") {
        const currentDevice = await this.options.devices.getActive(
          authorizedDevice.id,
        );
        if (!currentDevice
          || currentDevice.signingPublicKey !== authorizedDevice.signingPublicKey
          || currentDevice.keyAgreementPublicKey !== authorizedDevice.keyAgreementPublicKey) {
          throw new TypeError("device authorization changed before capability issuance");
        }

        const link = await this.#registry.createLink(
          request.payload.instanceId,
          request.payload.generation,
          request.payload.access,
          {
            machineId: this.options.machine.id,
            deviceId: currentDevice.id,
            ...(request.payload.resumeFromHostSeq !== undefined
              ? { resumeFromHostSeq: request.payload.resumeFromHostSeq }
              : {}),
          },
        );
        replayFrames = link.replayFrames;

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

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(response));
      if (response.ok) {
        for (const frame of replayFrames) {
          this.#sendRpcFrame(frame);
        }
      }
    }
  }
}
