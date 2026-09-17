import assert from "node:assert/strict";
import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AuthorizedDeviceStore } from "./authorizedDevices.js";
import { loadOrCreateMachineIdentity } from "./machineIdentity.js";
import {
  PairingError,
  PairingService,
  pairingAcceptanceMessage,
  pairingRequestMessage,
  type PairingDevicePublicIdentity,
  type PairingRequest,
} from "./pairing.js";

function makeDevice(): {
  identity: PairingDevicePublicIdentity;
  signingPrivateKey: ReturnType<typeof createPrivateKey>;
} {
  const signing = generateKeyPairSync("ed25519");
  const agreement = generateKeyPairSync("x25519");
  const signingPublicJwk = signing.publicKey.export({ format: "jwk" });
  const agreementPublicJwk = agreement.publicKey.export({ format: "jwk" });

  assert.equal(signingPublicJwk.kty, "OKP");
  assert.equal(signingPublicJwk.crv, "Ed25519");
  assert.ok(signingPublicJwk.x);
  assert.equal(agreementPublicJwk.kty, "OKP");
  assert.equal(agreementPublicJwk.crv, "X25519");
  assert.ok(agreementPublicJwk.x);

  return {
    identity: {
      id: "device_testiphone",
      name: "iPhone",
      signingPublicKey: signingPublicJwk.x,
      keyAgreementPublicKey: agreementPublicJwk.x,
    },
    signingPrivateKey: signing.privateKey,
  };
}

function validRequest(
  invitation: ReturnType<PairingService["createInvitation"]>,
  device: ReturnType<typeof makeDevice>,
): PairingRequest {
  const message = pairingRequestMessage({
    pairingId: invitation.pairingId,
    machineId: invitation.machine.id,
    device: device.identity,
  });

  return {
    version: 1,
    pairingId: invitation.pairingId,
    machineId: invitation.machine.id,
    device: device.identity,
    proof: createHmac("sha256", Buffer.from(invitation.secret, "base64url"))
      .update(message)
      .digest("base64url"),
    deviceSignature: sign(null, message, device.signingPrivateKey).toString("base64url"),
  };
}

test("valid one-time pairing authorizes a device and cannot be replayed", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-remote-pairing-"));
  const machine = await loadOrCreateMachineIdentity(path.join(dir, "machine.json"));
  const devices = new AuthorizedDeviceStore(path.join(dir, "devices.json"));
  const now = 1_800_000_000_000;
  const service = new PairingService(machine, devices, () => now);
  const invitation = service.createInvitation();
  const device = makeDevice();
  const request = validRequest(invitation, device);

  const acceptance = await service.accept(request);

  assert.equal(acceptance.machine.id, machine.id);
  assert.equal(acceptance.deviceId, device.identity.id);

  const authorized = await devices.getActive(device.identity.id);
  assert.equal(authorized?.signingPublicKey, device.identity.signingPublicKey);
  assert.equal(authorized?.keyAgreementPublicKey, device.identity.keyAgreementPublicKey);

  const hostPublicKey = createPublicKey({
    key: {
      kty: "OKP",
      crv: "Ed25519",
      x: acceptance.machine.signingPublicKey,
    },
    format: "jwk",
  });
  const acceptanceMessage = pairingAcceptanceMessage({
    pairingId: acceptance.pairingId,
    machineId: acceptance.machine.id,
    device: device.identity,
    acceptedAt: acceptance.acceptedAt,
  });
  assert.equal(
    verify(
      null,
      acceptanceMessage,
      hostPublicKey,
      Buffer.from(acceptance.hostSignature, "base64url"),
    ),
    true,
  );

  await assert.rejects(
    () => service.accept(request),
    (error: unknown) => error instanceof PairingError && error.code === "unknown_pairing",
  );
});

test("pairing rejects a request without the QR secret", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-remote-pairing-proof-"));
  const machine = await loadOrCreateMachineIdentity(path.join(dir, "machine.json"));
  const devices = new AuthorizedDeviceStore(path.join(dir, "devices.json"));
  const service = new PairingService(machine, devices);
  const invitation = service.createInvitation();
  const device = makeDevice();
  const request = validRequest(invitation, device);

  request.proof = Buffer.alloc(32, 7).toString("base64url");

  await assert.rejects(
    () => service.accept(request),
    (error: unknown) => error instanceof PairingError && error.code === "invalid_proof",
  );

  assert.equal(await devices.getActive(device.identity.id), null);
});

test("pairing rejects a forged device signature", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-remote-pairing-signature-"));
  const machine = await loadOrCreateMachineIdentity(path.join(dir, "machine.json"));
  const devices = new AuthorizedDeviceStore(path.join(dir, "devices.json"));
  const service = new PairingService(machine, devices);
  const invitation = service.createInvitation();
  const device = makeDevice();
  const request = validRequest(invitation, device);

  request.deviceSignature = Buffer.alloc(64, 3).toString("base64url");

  await assert.rejects(
    () => service.accept(request),
    (error: unknown) => error instanceof PairingError && error.code === "invalid_signature",
  );

  assert.equal(await devices.getActive(device.identity.id), null);
});

test("expired pairing challenges cannot authorize a device", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-remote-pairing-expiry-"));
  const machine = await loadOrCreateMachineIdentity(path.join(dir, "machine.json"));
  const devices = new AuthorizedDeviceStore(path.join(dir, "devices.json"));
  let now = 1_800_000_000_000;
  const service = new PairingService(machine, devices, () => now);
  const invitation = service.createInvitation(10_000);
  const device = makeDevice();
  const request = validRequest(invitation, device);

  now += 10_001;

  await assert.rejects(
    () => service.accept(request),
    (error: unknown) => error instanceof PairingError && error.code === "expired_pairing",
  );
});

test("revocation disables a device but preserves its audit record", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-remote-revoke-"));
  const devices = new AuthorizedDeviceStore(path.join(dir, "devices.json"));

  await devices.authorize({
    id: "device_revoke",
    name: "Old iPhone",
    signingPublicKey: Buffer.alloc(32, 1).toString("base64url"),
    keyAgreementPublicKey: Buffer.alloc(32, 2).toString("base64url"),
    pairedAt: "2026-09-18T00:00:00.000Z",
  });

  assert.ok(await devices.getActive("device_revoke"));
  assert.equal(
    await devices.revoke("device_revoke", "2026-09-18T00:01:00.000Z"),
    true,
  );
  assert.equal(await devices.getActive("device_revoke"), null);

  const [record] = await devices.list();
  assert.equal(record?.revokedAt, "2026-09-18T00:01:00.000Z");
});
