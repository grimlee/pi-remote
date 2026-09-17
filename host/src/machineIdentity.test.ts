import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  loadOrCreateMachineIdentity,
  publicMachineIdentity,
} from "./machineIdentity.js";

test("machine identity and cryptographic keys are stable once created", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-remote-identity-"));
  const file = path.join(dir, "machine.json");

  const first = await loadOrCreateMachineIdentity(file);
  const second = await loadOrCreateMachineIdentity(file);

  assert.deepEqual(second, first);
  assert.match(first.id, /^machine_[0-9a-f]{32}$/);
  assert.equal(first.signingPrivateKey.crv, "Ed25519");
  assert.equal(first.keyAgreementPrivateKey.crv, "X25519");

  const publicIdentity = publicMachineIdentity(first);
  assert.equal(publicIdentity.id, first.id);
  assert.equal(publicIdentity.signingPublicKey, first.signingPrivateKey.x);
  assert.equal(publicIdentity.keyAgreementPublicKey, first.keyAgreementPrivateKey.x);
  assert.ok(publicIdentity.fingerprint.length >= 40);

  const persisted = JSON.parse(await readFile(file, "utf8")) as { version: number; id: string };
  assert.equal(persisted.version, 2);
  assert.equal(persisted.id, first.id);

  if (process.platform !== "win32") {
    const mode = (await stat(file)).mode & 0o777;
    assert.equal(mode, 0o600);
  }
});

test("legacy machine identity upgrades without changing the machine id", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-remote-identity-migration-"));
  const file = path.join(dir, "machine.json");

  await writeFile(file, JSON.stringify({
    id: "machine_legacy123",
    name: "omarchy",
    platform: "linux",
  }));

  const upgraded = await loadOrCreateMachineIdentity(file);

  assert.equal(upgraded.version, 2);
  assert.equal(upgraded.id, "machine_legacy123");
  assert.equal(upgraded.name, "omarchy");
  assert.equal(upgraded.platform, "linux");
  assert.equal(upgraded.signingPrivateKey.crv, "Ed25519");
  assert.equal(upgraded.keyAgreementPrivateKey.crv, "X25519");
});
