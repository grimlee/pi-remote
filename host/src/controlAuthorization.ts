import { createPublicKey, verify } from "node:crypto";
import type { AuthorizedDevice, AuthorizedDeviceStore } from "./authorizedDevices.js";
import type { SessionAccess } from "./types.js";

export interface ControlAuthorization {
  deviceId: string;
  issuedAtMs: number;
  signature: string;
}

export type SignedControlPayload =
  | { op: "sessions.list" }
  | {
      op: "sessions.link";
      instanceId: string;
      generation: number;
      access: SessionAccess;
    };

export interface SignedControlRequest {
  protocolVersion: 0;
  type: "control.request";
  requestId: string;
  machineId: string;
  payload: SignedControlPayload;
  authorization: ControlAuthorization;
}

function field(value: string): Buffer {
  return Buffer.from(value, "utf8");
}

export function controlRequestMessage(
  request: Omit<SignedControlRequest, "authorization"> & {
    authorization: Pick<ControlAuthorization, "deviceId" | "issuedAtMs">;
  },
): Buffer {
  const base = [
    Buffer.from("piremote-control-request-v1\0", "utf8"),
    field(request.requestId), Buffer.from([0]),
    field(request.machineId), Buffer.from([0]),
    field(request.authorization.deviceId), Buffer.from([0]),
    field(String(request.authorization.issuedAtMs)), Buffer.from([0]),
    field(request.payload.op),
  ];

  if (request.payload.op === "sessions.list") {
    return Buffer.concat(base);
  }

  return Buffer.concat([
    ...base,
    Buffer.from([0]),
    field(request.payload.instanceId), Buffer.from([0]),
    field(String(request.payload.generation)), Buffer.from([0]),
    field(request.payload.access),
  ]);
}

export class ControlRequestAuthorizer {
  readonly #seen = new Map<string, number>();

  constructor(
    private readonly devices: AuthorizedDeviceStore,
    private readonly machineId: string,
    private readonly now: () => number = Date.now,
    private readonly maxSkewMs = 60_000,
  ) {}

  async authorize(request: SignedControlRequest): Promise<AuthorizedDevice | null> {
    const now = this.now();
    this.#prune(now);

    if (request.machineId !== this.machineId
      || !Number.isSafeInteger(request.authorization.issuedAtMs)
      || Math.abs(now - request.authorization.issuedAtMs) > this.maxSkewMs
      || this.#seen.has(request.requestId)) {
      return null;
    }

    const device = await this.devices.getActive(request.authorization.deviceId);
    if (!device) return null;

    let valid = false;
    try {
      const publicKey = createPublicKey({
        key: {
          kty: "OKP",
          crv: "Ed25519",
          x: device.signingPublicKey,
        },
        format: "jwk",
      });
      valid = verify(
        null,
        controlRequestMessage({
          ...request,
          authorization: {
            deviceId: request.authorization.deviceId,
            issuedAtMs: request.authorization.issuedAtMs,
          },
        }),
        publicKey,
        Buffer.from(request.authorization.signature, "base64url"),
      );
    } catch {
      valid = false;
    }

    if (!valid) return null;

    this.#seen.set(request.requestId, now);
    return device;
  }

  #prune(now: number): void {
    const cutoff = now - this.maxSkewMs * 2;
    for (const [requestId, seenAt] of this.#seen) {
      if (seenAt < cutoff) this.#seen.delete(requestId);
    }
  }
}
