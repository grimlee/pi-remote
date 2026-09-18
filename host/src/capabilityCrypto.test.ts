import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import type { AuthorizedDevice } from "./authorizedDevices.js";
import {
  decryptCollabCapabilityForTest,
  encryptCollabCapability,
} from "./capabilityCrypto.js";
import type {
  MachineIdentity,
  StoredOkpPrivateKey,
} from "./machineIdentity.js";
import type { SessionLink } from "./types.js";

function privateJwk(type: "ed25519" | "x25519"): StoredOkpPrivateKey {
  const pair = type === "ed25519"
    ? generateKeyPairSync("ed25519")
    : generateKeyPairSync("x25519");
  const jwk = pair.privateKey.export({ format: "jwk" });
  assert.equal(jwk.kty, "OKP");
  assert.ok(jwk.crv);
  assert.ok(jwk.x);
  assert.ok(jwk.d);
  return {
    kty: "OKP",
    crv: jwk.crv as "Ed25519" | "X25519",
    x: jwk.x,
    d: jwk.d,
  };
}

function fixture() {
  const machine: MachineIdentity = {
    version: 2,
    id: "machine_test",
    name: "omarchy",
    platform: "linux",
    signingPrivateKey: privateJwk("ed25519"),
    keyAgreementPrivateKey: privateJwk("x25519"),
  };
  const deviceAgreement = generateKeyPairSync("x25519");
  const deviceAgreementPrivate = deviceAgreement.privateKey.export({ format: "jwk" });
  const deviceAgreementPublic = deviceAgreement.publicKey.export({ format: "jwk" });
  assert.ok(deviceAgreementPublic.x);

  const deviceSigning = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" });
  assert.ok(deviceSigning.x);

  const device: AuthorizedDevice = {
    id: "device_test",
    name: "iPhone",
    signingPublicKey: deviceSigning.x,
    keyAgreementPublicKey: deviceAgreementPublic.x,
    role: "owner",
    pairedAt: "2026-09-18T00:00:00.000Z",
    revokedAt: null,
  };
  const link: SessionLink = {
    instanceId: "instance_test",
    generation: 7,
    access: "control",
    collabUrl: "https://collab.example/#super-secret-capability",
  };

  return { machine, device, deviceAgreementPrivate, link };
}

test("encrypts Collab capability only for the paired device", () => {
  const { machine, device, deviceAgreementPrivate, link } = fixture();

  const envelope = encryptCollabCapability(
    machine,
    device,
    "req_test",
    link,
  );

  assert.equal(envelope.machineId, machine.id);
  assert.equal(envelope.deviceId, device.id);
  assert.equal(envelope.instanceId, link.instanceId);
  assert.equal(envelope.generation, link.generation);
  assert.equal(envelope.access, link.access);
  assert.equal(
    JSON.stringify(envelope).includes(link.collabUrl),
    false,
  );

  assert.equal(
    decryptCollabCapabilityForTest(
      envelope,
      deviceAgreementPrivate,
      machine.keyAgreementPrivateKey.x,
    ),
    link.collabUrl,
  );
});

test("authenticated capability context rejects relay tampering", () => {
  const { machine, device, deviceAgreementPrivate, link } = fixture();
  const envelope = encryptCollabCapability(
    machine,
    device,
    "req_test",
    link,
  );

  const tampered = {
    ...envelope,
    generation: envelope.generation + 1,
  };

  assert.throws(() => {
    decryptCollabCapabilityForTest(
      tampered,
      deviceAgreementPrivate,
      machine.keyAgreementPrivateKey.x,
    );
  });
});

test("a different device private key cannot decrypt the capability", () => {
  const { machine, device, link } = fixture();
  const envelope = encryptCollabCapability(
    machine,
    device,
    "req_test",
    link,
  );
  const attacker = generateKeyPairSync("x25519").privateKey.export({ format: "jwk" });

  assert.throws(() => {
    decryptCollabCapabilityForTest(
      envelope,
      attacker,
      machine.keyAgreementPrivateKey.x,
    );
  });
});
