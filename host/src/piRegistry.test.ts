import assert from "node:assert/strict";
import test from "node:test";
import { PiRegistry, PiRegistryError, parseSessionLink, parseSessionList } from "./piRegistry.js";
import type { CommandRunner } from "./types.js";

const host = {
  instanceId: "abcd1234",
  generation: 4,
  pid: 1234,
  sessionId: "session-1",
  sessionName: "Fix tests",
  cwd: "/home/user/project",
  model: { provider: "openai", id: "gpt-5" },
  startedAt: Date.UTC(2026, 8, 17, 12, 0, 0),
  participants: 2,
  relayConnected: true,
  inputRequired: false,
  access: "control",
};

test("parseSessionList normalizes Pi registry output", () => {
  const sessions = parseSessionList(JSON.stringify({ version: 1, hosts: [host] }));
  assert.deepEqual(sessions, [
    {
      instanceId: "abcd1234",
      generation: 4,
      sessionId: "session-1",
      name: "Fix tests",
      cwd: "/home/user/project",
      model: "openai/gpt-5",
      startedAt: "2026-09-17T12:00:00.000Z",
      participantCount: 2,
      relayConnected: true,
      inputRequired: false,
      access: "control",
    },
  ]);
});

test("parseSessionLink accepts the upstream JSON shape", () => {
  assert.deepEqual(
    parseSessionLink(JSON.stringify({
      version: 1,
      instanceId: "abcd1234",
      generation: 4,
      access: "control",
      url: "https://my.omp.sh/#secret",
    })),
    {
      instanceId: "abcd1234",
      generation: 4,
      access: "control",
      collabUrl: "https://my.omp.sh/#secret",
    },
  );
});

test("createLink rejects a mobile selection whose generation is stale", async () => {
  const runner: CommandRunner = {
    async run() {
      return {
        stdout: JSON.stringify({
          version: 1,
          instanceId: "abcd1234",
          generation: 5,
          access: "control",
          url: "https://my.omp.sh/#secret",
        }),
        stderr: "",
      };
    },
  };

  const registry = new PiRegistry(runner);
  await assert.rejects(
    registry.createLink("abcd1234", 4, "control"),
    (error: unknown) => error instanceof PiRegistryError && error.code === "stale_generation",
  );
});
