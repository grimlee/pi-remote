import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import type { RelayAuthPrincipal } from "./auth.js";
import type {
  ClientHello,
  MachineDescriptor,
  PairingRequestFrame,
  PairingResponseFrame,
} from "./protocol.js";
import type { RelayPeer } from "./router.js";
import { RelayRouter } from "./router.js";

class FakePeer implements RelayPeer {
  readonly sent: string[] = [];
  closed: { code: number | undefined; reason: string | undefined } | null = null;

  send(text: string): void {
    this.sent.push(text);
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
}

function publicKey(type: "ed25519" | "x25519"): string {
  const pair = type === "ed25519"
    ? generateKeyPairSync("ed25519")
    : generateKeyPairSync("x25519");
  const jwk = pair.publicKey.export({ format: "jwk" });
  assert.ok(jwk.x);
  return jwk.x;
}

test("unpaired authenticated device can route pairing only to exact host key", () => {
  const router = new RelayRouter();
  const host = new FakePeer();
  const client = new FakePeer();

  const machine: MachineDescriptor = {
    id: "machine_test",
    name: "omarchy",
    platform: "linux",
    capabilities: ["sessions.list", "sessions.link"],
    signingPublicKey: publicKey("ed25519"),
    keyAgreementPublicKey: publicKey("x25519"),
    fingerprint: "fingerprint",
  };
  const device: ClientHello["device"] = {
    id: "device_test",
    name: "iPhone",
    signingPublicKey: publicKey("ed25519"),
    keyAgreementPublicKey: publicKey("x25519"),
  };
  const principal: RelayAuthPrincipal = {
    kind: "device",
    id: device.id,
    signingPublicKey: device.signingPublicKey,
  };

  router.registerHost(host, machine);
  router.registerClient(client, principal, device);

  const request: PairingRequestFrame = {
    protocolVersion: 0,
    type: "pairing.request",
    requestId: "pair_req_1",
    machine: {
      id: machine.id,
      signingPublicKey: machine.signingPublicKey,
    },
    pairing: {
      version: 1,
      pairingId: "pair_invitation",
      machineId: machine.id,
      device,
      proof: "proof",
      deviceSignature: "signature",
    },
  };

  router.routePairingRequest(client, request);
  assert.deepEqual(JSON.parse(host.sent.at(-1) ?? "{}"), request);

  const response: PairingResponseFrame = {
    protocolVersion: 0,
    type: "pairing.response",
    requestId: request.requestId,
    machineId: machine.id,
    ok: true,
    acceptance: { version: 1 },
  };
  router.routePairingResponse(host, response);
  assert.deepEqual(JSON.parse(client.sent.at(-1) ?? "{}"), response);
});

test("pairing request cannot be retargeted to same machine id with another key", () => {
  const router = new RelayRouter();
  const host = new FakePeer();
  const client = new FakePeer();

  const machine: MachineDescriptor = {
    id: "machine_test",
    name: "omarchy",
    platform: "linux",
    capabilities: [],
    signingPublicKey: publicKey("ed25519"),
    keyAgreementPublicKey: publicKey("x25519"),
    fingerprint: "fingerprint",
  };
  const device: ClientHello["device"] = {
    id: "device_test",
    name: "iPhone",
    signingPublicKey: publicKey("ed25519"),
    keyAgreementPublicKey: publicKey("x25519"),
  };

  router.registerHost(host, machine);
  router.registerClient(client, {
    kind: "device",
    id: device.id,
    signingPublicKey: device.signingPublicKey,
  }, device);

  router.routePairingRequest(client, {
    protocolVersion: 0,
    type: "pairing.request",
    requestId: "pair_req_bad",
    machine: {
      id: machine.id,
      signingPublicKey: publicKey("ed25519"),
    },
    pairing: {
      version: 1,
      pairingId: "pair_invitation",
      machineId: machine.id,
      device,
      proof: "proof",
      deviceSignature: "signature",
    },
  });

  assert.equal(host.sent.length, 0);
  const response = JSON.parse(client.sent.at(-1) ?? "{}") as PairingResponseFrame;
  assert.equal(response.ok, false);
  assert.equal(response.error?.code, "machine_offline");
});
