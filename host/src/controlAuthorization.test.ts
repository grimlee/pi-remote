import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AuthorizedDeviceStore } from "./authorizedDevices.js";
import {
  ControlRequestAuthorizer,
  controlRequestMessage,
  type SignedControlRequest,
} from "./controlAuthorization.js";

function unsignedList(issuedAtMs = 1_800_000_000_000) {
  return {
    protocolVersion: 0 as const,
    type: "control.request" as const,
    requestId: "req_testvector",
    machineId: "machine_testvector",
    payload: { op: "sessions.list" as const },
    authorization: {
      deviceId: "device_testvector",
      issuedAtMs,
    },
  };
}

test("control request canonical bytes match Swift vector", () => {
  assert.equal(
    controlRequestMessage(unsignedList()).toString("base64url"),
    "cGlyZW1vdGUtY29udHJvbC1yZXF1ZXN0LXYxAHJlcV90ZXN0dmVjdG9yAG1hY2hpbmVfdGVzdHZlY3RvcgBkZXZpY2VfdGVzdHZlY3RvcgAxODAwMDAwMDAwMDAwAHNlc3Npb25zLmxpc3Q",
  );

  const link = {
    protocolVersion: 0 as const,
    type: "control.request" as const,
    requestId: "req_testvector",
    machineId: "machine_testvector",
    payload: {
      op: "sessions.link" as const,
      instanceId: "instance_test",
      generation: 7,
      access: "control" as const,
    },
    authorization: {
      deviceId: "device_testvector",
      issuedAtMs: 1_800_000_000_000,
    },
  };

  assert.equal(
    controlRequestMessage(link).toString("base64url"),
    "cGlyZW1vdGUtY29udHJvbC1yZXF1ZXN0LXYxAHJlcV90ZXN0dmVjdG9yAG1hY2hpbmVfdGVzdHZlY3RvcgBkZXZpY2VfdGVzdHZlY3RvcgAxODAwMDAwMDAwMDAwAHNlc3Npb25zLmxpbmsAaW5zdGFuY2VfdGVzdAA3AGNvbnRyb2w",
  );
});

test("host authorizes a valid signed request once and rejects replay", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-remote-control-auth-"));
  const devices = new AuthorizedDeviceStore(path.join(dir, "devices.json"));
  const keys = generateKeyPairSync("ed25519");
  const publicJwk = keys.publicKey.export({ format: "jwk" });
  assert.ok(publicJwk.x);

  await devices.authorize({
    id: "device_testvector",
    name: "iPhone",
    signingPublicKey: publicJwk.x,
    keyAgreementPublicKey: Buffer.alloc(32, 4).toString("base64url"),
    pairedAt: "2026-09-18T00:00:00.000Z",
  });

  const unsigned = unsignedList();
  const request: SignedControlRequest = {
    ...unsigned,
    authorization: {
      ...unsigned.authorization,
      signature: sign(
        null,
        controlRequestMessage(unsigned),
        keys.privateKey,
      ).toString("base64url"),
    },
  };

  const authorizer = new ControlRequestAuthorizer(
    devices,
    "machine_testvector",
    () => 1_800_000_000_000,
  );

  assert.equal((await authorizer.authorize(request))?.id, "device_testvector");
  assert.equal(await authorizer.authorize(request), null);
});

test("host rejects expired and revoked device requests", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-remote-control-revoke-"));
  const devices = new AuthorizedDeviceStore(path.join(dir, "devices.json"));
  const keys = generateKeyPairSync("ed25519");
  const publicJwk = keys.publicKey.export({ format: "jwk" });
  assert.ok(publicJwk.x);

  await devices.authorize({
    id: "device_testvector",
    name: "iPhone",
    signingPublicKey: publicJwk.x,
    keyAgreementPublicKey: Buffer.alloc(32, 5).toString("base64url"),
    pairedAt: "2026-09-18T00:00:00.000Z",
  });

  const authorizer = new ControlRequestAuthorizer(
    devices,
    "machine_testvector",
    () => 1_800_000_000_000,
  );

  const expiredUnsigned = unsignedList(1_799_999_900_000);
  const expired: SignedControlRequest = {
    ...expiredUnsigned,
    authorization: {
      ...expiredUnsigned.authorization,
      signature: sign(
        null,
        controlRequestMessage(expiredUnsigned),
        keys.privateKey,
      ).toString("base64url"),
    },
  };
  assert.equal(await authorizer.authorize(expired), null);

  const currentUnsigned = unsignedList();
  const current: SignedControlRequest = {
    ...currentUnsigned,
    authorization: {
      ...currentUnsigned.authorization,
      signature: sign(
        null,
        controlRequestMessage(currentUnsigned),
        keys.privateKey,
      ).toString("base64url"),
    },
  };
  await devices.revoke(
    "device_testvector",
    "2026-09-18T00:01:00.000Z",
  );
  assert.equal(await authorizer.authorize(current), null);
});
