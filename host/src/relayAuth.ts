import { createPrivateKey, sign } from "node:crypto";
import type { MachineIdentity } from "./machineIdentity.js";

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

export function signHostRelayChallenge(
  machine: MachineIdentity,
  challenge: RelayAuthChallenge,
): RelayAuthResponse {
  const principal: RelayAuthPrincipal = {
    kind: "machine",
    id: machine.id,
    signingPublicKey: machine.signingPrivateKey.x,
  };
  const key = machine.signingPrivateKey;
  const privateKey = createPrivateKey({
    key: {
      kty: key.kty,
      crv: key.crv,
      x: key.x,
      d: key.d,
    },
    format: "jwk",
  });

  return {
    protocolVersion: 0,
    type: "auth.response",
    challengeId: challenge.challengeId,
    principal,
    signature: sign(
      null,
      relayAuthMessage(challenge, principal),
      privateKey,
    ).toString("base64url"),
  };
}
