import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadOrCreateMachineIdentity } from "./machineIdentity.js";

test("machine identity is stable once created", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-remote-identity-"));
  const file = path.join(dir, "machine.json");

  const first = await loadOrCreateMachineIdentity(file);
  const second = await loadOrCreateMachineIdentity(file);

  assert.equal(second.id, first.id);
  assert.equal(second.name, first.name);
  assert.equal(second.platform, first.platform);

  const persisted = JSON.parse(await readFile(file, "utf8")) as { id: string };
  assert.equal(persisted.id, first.id);
  assert.match(first.id, /^machine_[0-9a-f]{32}$/);
});
