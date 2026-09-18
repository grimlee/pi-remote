import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  randomUUID,
  sign,
  timingSafeEqual,
  verify,
} from "node:crypto";
import type { AuthorizedDeviceStore } from "./authorizedDevices.js";
import { issueMachineGrant, type MachineGrant } from "./machineGrant.js";
import {
  publicMachineIdentity,
  type MachineIdentity,
  type PublicMachineIdentity,
} from "./machineIdentity.js";

export interface PairingInvitation {
  version: 1;
  pairingId: string;
  machine: PublicMachineIdentity;
  expiresAt: string;
  secret: string;
}

export interface PairingDevicePublicIdentity {
  id: string;
  name: string;
  signingPublicKey: string;
  keyAgreementPublicKey: string;
}

export interface PairingRequest {
  version: 1;
  pairingId: string;
  machineId: string;
  device: PairingDevicePublicIdentity;
  proof: string;
  deviceSignature: string;
}

export interface PairingAcceptance {
  version: 1;
  pairingId: string;
  machine: PublicMachineIdentity;
  deviceId: string;
  acceptedAt: string;
  hostSignature: string;
  grant: MachineGrant;
}

export class PairingError extends Error {
  constructor(
    readonly code:
      | "unknown_pairing"
      | "expired_pairing"
      | "invalid_request"
      | "invalid_proof"
      | "invalid_signature",
    message: string,
  ) {
    super(message);
    this.name = "PairingError";
  }
}

interface Challenge {
  secret: Buffer;
  expiresAtMs: number;
}

function textField(value: string): Buffer {
  return Buffer.from(value, "utf8");
}

export function pairingRequestMessage(input: {
  pairingId: string;
  machineId: string;
  device: PairingDevicePublicIdentity;
}): Buffer {
  return Buffer.concat([
    Buffer.from("piremote-pair-request-v1\0", "utf8"),
    textField(input.pairingId), Buffer.from([0]),
    textField(input.machineId), Buffer.from([0]),
    textField(input.device.id), Buffer.from([0]),
    textField(input.device.name), Buffer.from([0]),
    textField(input.device.signingPublicKey), Buffer.from([0]),
    textField(input.device.keyAgreementPublicKey),
  ]);
}

export function pairingAcceptanceMessage(input: {
  pairingId: string;
  machineId: string;
  device: PairingDevicePublicIdentity;
  acceptedAt: string;
}): Buffer {
  return Buffer.concat([
    Buffer.from("piremote-pair-accept-v1\0", "utf8"),
    textField(input.pairingId), Buffer.from([0]),
    textField(input.machineId), Buffer.from([0]),
    textField(input.device.id), Buffer.from([0]),
    textField(input.device.signingPublicKey), Buffer.from([0]),
    textField(input.device.keyAgreementPublicKey), Buffer.from([0]),
    textField(input.acceptedAt),
  ]);
}

function hostSigningPrivateKey(identity: MachineIdentity) {
  const key = identity.signingPrivateKey;
  return createPrivateKey({
    key: {
      kty: key.kty,
      crv: key.crv,
      x: key.x,
      d: key.d,
    },
    format: "jwk",
  });
}

function deviceSigningPublicKey(x: string) {
  return createPublicKey({
    key: {
      kty: "OKP",
      crv: "Ed25519",
      x,
    },
    format: "jwk",
  });
}

function decodeBase64Url(value: string, fieldName: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new PairingError("invalid_request", fieldName + " is not valid base64url");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length === 0) {
    throw new PairingError("invalid_request", fieldName + " is empty");
  }
  return decoded;
}

function validateDevice(device: PairingDevicePublicIdentity): void {
  if (!device.id.startsWith("device_") || device.id.length > 96) {
    throw new PairingError("invalid_request", "invalid device id");
  }
  if (device.name.length < 1 || device.name.length > 128) {
    throw new PairingError("invalid_request", "invalid device name");
  }

  const signing = decodeBase64Url(device.signingPublicKey, "signingPublicKey");
  const agreement = decodeBase64Url(device.keyAgreementPublicKey, "keyAgreementPublicKey");
  if (signing.length !== 32 || agreement.length !== 32) {
    throw new PairingError("invalid_request", "device public keys must be 32 bytes");
  }
}

export class PairingService {
  readonly #challenges = new Map<string, Challenge>();

  constructor(
    private readonly machine: MachineIdentity,
    private readonly devices: AuthorizedDeviceStore,
    private readonly now: () => number = Date.now,
  ) {}

  createInvitation(ttlMs = 120_000): PairingInvitation {
    if (!Number.isFinite(ttlMs) || ttlMs < 10_000 || ttlMs > 10 * 60_000) {
      throw new RangeError("pairing ttl must be between 10 seconds and 10 minutes");
    }

    this.#pruneExpired();

    const pairingId = "pair_" + randomUUID().replaceAll("-", "");
    const secret = randomBytes(32);
    const expiresAtMs = this.now() + ttlMs;

    this.#challenges.set(pairingId, { secret, expiresAtMs });

    return {
      version: 1,
      pairingId,
      machine: publicMachineIdentity(this.machine),
      expiresAt: new Date(expiresAtMs).toISOString(),
      secret: secret.toString("base64url"),
    };
  }

  async accept(request: PairingRequest): Promise<PairingAcceptance> {
    if (request.version !== 1) {
      throw new PairingError("invalid_request", "unsupported pairing version");
    }
    if (request.machineId !== this.machine.id) {
      throw new PairingError("invalid_request", "pairing request targets a different machine");
    }

    validateDevice(request.device);

    const challenge = this.#challenges.get(request.pairingId);
    if (!challenge) {
      throw new PairingError("unknown_pairing", "pairing challenge is unknown or already used");
    }
    if (challenge.expiresAtMs <= this.now()) {
      this.#challenges.delete(request.pairingId);
      throw new PairingError("expired_pairing", "pairing challenge expired");
    }

    const message = pairingRequestMessage({
      pairingId: request.pairingId,
      machineId: request.machineId,
      device: request.device,
    });

    const expectedProof = createHmac("sha256", challenge.secret).update(message).digest();
    const proof = decodeBase64Url(request.proof, "proof");
    if (proof.length !== expectedProof.length || !timingSafeEqual(proof, expectedProof)) {
      throw new PairingError("invalid_proof", "pairing proof is invalid");
    }

    const signature = decodeBase64Url(request.deviceSignature, "deviceSignature");
    let validSignature = false;
    try {
      validSignature = verify(
        null,
        message,
        deviceSigningPublicKey(request.device.signingPublicKey),
        signature,
      );
    } catch {
      validSignature = false;
    }
    if (!validSignature) {
      throw new PairingError("invalid_signature", "device signature is invalid");
    }

    const acceptedAt = new Date(this.now()).toISOString();
    const grant = issueMachineGrant(this.machine, request.device, acceptedAt);

    await this.devices.authorize({
      id: request.device.id,
      name: request.device.name,
      signingPublicKey: request.device.signingPublicKey,
      keyAgreementPublicKey: request.device.keyAgreementPublicKey,
      pairedAt: acceptedAt,
    });

    this.#challenges.delete(request.pairingId);

    const hostSignature = sign(
      null,
      pairingAcceptanceMessage({
        pairingId: request.pairingId,
        machineId: this.machine.id,
        device: request.device,
        acceptedAt,
      }),
      hostSigningPrivateKey(this.machine),
    ).toString("base64url");

    return {
      version: 1,
      pairingId: request.pairingId,
      machine: publicMachineIdentity(this.machine),
      deviceId: request.device.id,
      acceptedAt,
      hostSignature,
      grant,
    };
  }

  #pruneExpired(): void {
    const now = this.now();
    for (const [pairingId, challenge] of this.#challenges) {
      if (challenge.expiresAtMs <= now) this.#challenges.delete(pairingId);
    }
  }
}
