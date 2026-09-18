import {
  createPublicKey,
  randomBytes,
  randomUUID,
  verify,
} from "node:crypto";

export type RelayAuthRole = "host" | "client";

export interface RelayAuthChallenge {
  protocolVersion: 0;
  type: "auth.challenge";
  challengeId: string;
  role: RelayAuthRole;
  nonce: string;
  expiresAt: string;
}

export interface RelayAuthPrincipal {
  kind: "machine" | "device";
  id: string;
  signingPublicKey: string;
}

export interface RelayAuthResponse {
  protocolVersion: 0;
  type: "auth.response";
  challengeId: string;
  principal: RelayAuthPrincipal;
  signature: string;
}

export interface RelayAuthAccepted {
  protocolVersion: 0;
  type: "auth.accepted";
  principal: RelayAuthPrincipal;
}

function field(value: string): Buffer {
  return Buffer.from(value, "utf8");
}

export function relayAuthMessage(
  challenge: RelayAuthChallenge,
  principal: RelayAuthPrincipal,
): Buffer {
  return Buffer.concat([
    Buffer.from("piremote-relay-auth-v1\0", "utf8"),
    field(challenge.role), Buffer.from([0]),
    field(challenge.challengeId), Buffer.from([0]),
    field(challenge.nonce), Buffer.from([0]),
    field(principal.kind), Buffer.from([0]),
    field(principal.id), Buffer.from([0]),
    field(principal.signingPublicKey),
  ]);
}

export function createRelayAuthChallenge(
  role: RelayAuthRole,
  now = Date.now(),
  ttlMs = 30_000,
): RelayAuthChallenge {
  if (!Number.isFinite(ttlMs) || ttlMs < 5_000 || ttlMs > 120_000) {
    throw new RangeError("relay auth ttl must be between 5 and 120 seconds");
  }

  return {
    protocolVersion: 0,
    type: "auth.challenge",
    challengeId: "auth_" + randomUUID().replaceAll("-", ""),
    role,
    nonce: randomBytes(32).toString("base64url"),
    expiresAt: new Date(now + ttlMs).toISOString(),
  };
}

export function verifyRelayAuthResponse(
  challenge: RelayAuthChallenge,
  response: RelayAuthResponse,
  now = Date.now(),
): boolean {
  if (response.protocolVersion !== 0
    || response.type !== "auth.response"
    || response.challengeId !== challenge.challengeId
    || Date.parse(challenge.expiresAt) <= now) {
    return false;
  }

  const expectedKind = challenge.role === "host" ? "machine" : "device";
  if (response.principal.kind !== expectedKind) return false;

  if (expectedKind === "machine" && !response.principal.id.startsWith("machine_")) return false;
  if (expectedKind === "device" && !response.principal.id.startsWith("device_")) return false;

  try {
    const publicKey = createPublicKey({
      key: {
        kty: "OKP",
        crv: "Ed25519",
        x: response.principal.signingPublicKey,
      },
      format: "jwk",
    });

    return verify(
      null,
      relayAuthMessage(challenge, response.principal),
      publicKey,
      Buffer.from(response.signature, "base64url"),
    );
  } catch {
    return false;
  }
}


export function isRelayAuthResponse(value: Record<string, unknown>): value is Record<string, unknown> & RelayAuthResponse {
  if (value.protocolVersion !== 0
    || value.type !== "auth.response"
    || typeof value.challengeId !== "string"
    || typeof value.signature !== "string") {
    return false;
  }

  const principal = value.principal;
  if (typeof principal !== "object" || principal === null || Array.isArray(principal)) {
    return false;
  }
  const record = principal as Record<string, unknown>;
  return (record.kind === "machine" || record.kind === "device")
    && typeof record.id === "string"
    && record.id.length > 0
    && typeof record.signingPublicKey === "string"
    && record.signingPublicKey.length >= 40;
}
