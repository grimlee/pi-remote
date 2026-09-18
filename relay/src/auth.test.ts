import assert from "node:assert/strict";
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import {
  createRelayAuthChallenge,
  relayAuthMessage,
  verifyRelayAuthResponse,
  type RelayAuthPrincipal,
  type RelayAuthResponse,
} from "./auth.js";

function fixedDeviceKey() {
  const key = generateKeyPairSync("ed25519");
  const publicJwk = key.publicKey.export({ format: "jwk" });
  assert.equal(publicJwk.kty, "OKP");
  assert.equal(publicJwk.crv, "Ed25519");
  assert.ok(publicJwk.x);
  return {
    privateKey: key.privateKey,
    publicKey: publicJwk.x,
  };
}

function signedResponse(
  challenge: ReturnType<typeof createRelayAuthChallenge>,
  principal: RelayAuthPrincipal,
  privateKey: ReturnType<typeof createPrivateKey>,
): RelayAuthResponse {
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

test("verifies a valid client challenge response", () => {
  const now = 1_800_000_000_000;
  const challenge = createRelayAuthChallenge("client", now);
  const key = fixedDeviceKey();
  const principal: RelayAuthPrincipal = {
    kind: "device",
    id: "device_test",
    signingPublicKey: key.publicKey,
  };
  const response = signedResponse(challenge, principal, key.privateKey);

  assert.equal(verifyRelayAuthResponse(challenge, response, now + 100), true);
});

test("rejects expired challenge response", () => {
  const now = 1_800_000_000_000;
  const challenge = createRelayAuthChallenge("client", now, 5_000);
  const key = fixedDeviceKey();
  const principal: RelayAuthPrincipal = {
    kind: "device",
    id: "device_test",
    signingPublicKey: key.publicKey,
  };
  const response = signedResponse(challenge, principal, key.privateKey);

  assert.equal(
    verifyRelayAuthResponse(challenge, response, now + 5_001),
    false,
  );
});

test("rejects signature from a different key", () => {
  const now = 1_800_000_000_000;
  const challenge = createRelayAuthChallenge("host", now);
  const claimed = fixedDeviceKey();
  const attacker = fixedDeviceKey();
  const principal: RelayAuthPrincipal = {
    kind: "machine",
    id: "machine_test",
    signingPublicKey: claimed.publicKey,
  };
  const response = signedResponse(challenge, principal, attacker.privateKey);

  assert.equal(verifyRelayAuthResponse(challenge, response, now + 100), false);
});

test("rejects role reflection", () => {
  const now = 1_800_000_000_000;
  const challenge = createRelayAuthChallenge("host", now);
  const key = fixedDeviceKey();
  const principal: RelayAuthPrincipal = {
    kind: "device",
    id: "device_test",
    signingPublicKey: key.publicKey,
  };
  const response = signedResponse(challenge, principal, key.privateKey);

  assert.equal(verifyRelayAuthResponse(challenge, response, now + 100), false);
});


test("relay auth canonical bytes match the Swift fixed vector", () => {
  const challenge = {
    protocolVersion: 0 as const,
    type: "auth.challenge" as const,
    challengeId: "auth_testvector",
    role: "client" as const,
    nonce: "IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI",
    expiresAt: "2026-09-18T00:00:30.000Z",
  };
  const principal: RelayAuthPrincipal = {
    kind: "device",
    id: "device_testvector",
    signingPublicKey: "yM6EbQV4R3kp5yy_dnkBqsme8jA9ypGFMbhwAvc6hZc",
  };

  assert.equal(
    relayAuthMessage(challenge, principal).toString("base64url"),
    "cGlyZW1vdGUtcmVsYXktYXV0aC12MQBjbGllbnQAYXV0aF90ZXN0dmVjdG9yAElpSWlJaUlpSWlJaUlpSWlJaUlpSWlJaUlpSWlJaUlpSWlJaUlpSWlJaUkAZGV2aWNlAGRldmljZV90ZXN0dmVjdG9yAHlNNkViUVY0UjNrcDV5eV9kbmtCcXNtZThqQTl5cEdGTWJod0F2YzZoWmM",
  );
});
