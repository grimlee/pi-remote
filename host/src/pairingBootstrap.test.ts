import assert from "node:assert/strict";
import test from "node:test";
import {
  decodePairingBootstrap,
  encodePairingBootstrap,
  relayClientUrl,
  type PairingBootstrap,
} from "./pairingBootstrap.js";

test("pairing bootstrap round trips and derives client relay endpoint", () => {
  assert.equal(
    relayClientUrl("wss://remote.example/v0/host"),
    "wss://remote.example/v0/client",
  );

  const bootstrap: PairingBootstrap = {
    version: 1,
    relayUrl: "wss://remote.example/v0/client",
    invitation: {
      version: 1,
      pairingId: "pair_test",
      machine: {
        id: "machine_test",
        name: "omarchy",
        platform: "linux",
        signingPublicKey: "signing",
        keyAgreementPublicKey: "agreement",
        fingerprint: "fingerprint",
      },
      expiresAt: "2026-09-18T00:02:00.000Z",
      secret: "secret",
    },
  };

  const encoded = encodePairingBootstrap(bootstrap);
  assert.ok(encoded.startsWith("piremote-pair-v1."));
  assert.deepEqual(decodePairingBootstrap(encoded), bootstrap);
});
