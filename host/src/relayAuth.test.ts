import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import test from "node:test";
import type { MachineIdentity } from "./machineIdentity.js";
import {
  relayAuthMessage,
  signHostRelayChallenge,
  type RelayAuthChallenge,
} from "./relayAuth.js";

test("host relay auth vector is stable and verifiable", () => {
  const machine: MachineIdentity = {
    version: 2,
    id: "machine_testvector",
    name: "omarchy",
    platform: "linux",
    signingPrivateKey: {
      kty: "OKP",
      crv: "Ed25519",
      d: "jbn9KEz7fM8HObbDQqmhRulxs0SGiHdA7ebtE7A-LP8",
      x: "ZuPCgpL12lNpVI89bigCIxa3d7xoXY1g6l5PU_p5N7Y",
    },
    keyAgreementPrivateKey: {
      kty: "OKP",
      crv: "X25519",
      d: "-MSzudJvN6kPuq45wQCs8U8iwYy5KQCI1-_w9GJ9DVE",
      x: "9fR7Li99huaimb2kfn_CarEsBG-jQAfjRZLsoDoSY0Q",
    },
  };
  const challenge: RelayAuthChallenge = {
    protocolVersion: 0,
    type: "auth.challenge",
    challengeId: "auth_hostvector",
    role: "host",
    nonce: "MzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM",
    expiresAt: "2026-09-18T00:00:30.000Z",
  };

  const response = signHostRelayChallenge(machine, challenge);
  const message = relayAuthMessage(challenge, response.principal);

  assert.equal(
    message.toString("base64url"),
    "cGlyZW1vdGUtcmVsYXktYXV0aC12MQBob3N0AGF1dGhfaG9zdHZlY3RvcgBNek16TXpNek16TXpNek16TXpNek16TXpNek16TXpNek16TXpNek16TXpNAG1hY2hpbmUAbWFjaGluZV90ZXN0dmVjdG9yAFp1UENncEwxMmxOcFZJODliaWdDSXhhM2Q3eG9YWTFnNmw1UFVfcDVON1k",
  );

  const publicKey = createPublicKey({
    key: {
      kty: "OKP",
      crv: "Ed25519",
      x: machine.signingPrivateKey.x,
    },
    format: "jwk",
  });

  assert.equal(
    verify(
      null,
      message,
      publicKey,
      Buffer.from(response.signature, "base64url"),
    ),
    true,
  );
});
