import assert from "node:assert/strict";
import test from "node:test";
import {
  decodePairingBootstrap,
  encodePairingBootstrap,
  relayClientUrl,
  type PairingBootstrap,
} from "./pairingBootstrap.js";

const invitation = {
  version: 1 as const,
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
};

test("pairing bootstrap round trips and derives client relay endpoint", () => {
  assert.equal(
    relayClientUrl("wss://remote.example/v0/host"),
    "wss://remote.example/v0/client",
  );

  const bootstrap: PairingBootstrap = {
    version: 1,
    relayUrl: "wss://remote.example/v0/client",
    invitation,
  };

  const encoded = encodePairingBootstrap(bootstrap);
  assert.ok(encoded.startsWith("piremote-pair-v1."));
  assert.deepEqual(decodePairingBootstrap(encoded), bootstrap);
});

test("pairing bootstrap carries Tailcat underlay metadata", () => {
  const bootstrap: PairingBootstrap = {
    version: 1,
    relayUrl: "ws://127.0.0.1:8780/v0/client",
    transport: {
      kind: "tailcat",
      address: "tcomFwWCCcjS5nKNqAod034nWoJZW0LZqDhhC8U_dKdnDRYQ8uNGFpGQEu",
      remotePort: 8780,
    },
    invitation,
  };

  assert.deepEqual(
    decodePairingBootstrap(encodePairingBootstrap(bootstrap)),
    bootstrap,
  );
});

test("pairing bootstrap rejects malformed Tailcat metadata", () => {
  const malformed = {
    version: 1,
    relayUrl: "ws://127.0.0.1:8780/v0/client",
    transport: {
      kind: "tailcat",
      address: "not-secret-address",
      remotePort: 0,
    },
    invitation,
  };

  const encoded = "piremote-pair-v1."
    + Buffer.from(JSON.stringify(malformed), "utf8").toString("base64url");

  assert.throws(
    () => decodePairingBootstrap(encoded),
    /invalid Pi Remote pairing transport/,
  );
});
