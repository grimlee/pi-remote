import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PiRegistry, PiRegistryError } from "./piRegistry.js";

async function writeSession(
  root: string,
  filename: string,
  values: unknown[],
): Promise<string> {
  const dir = path.join(root, "project");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, filename);
  await writeFile(file, values.map(value => JSON.stringify(value)).join("\n") + "\n");
  return file;
}

test("lists persisted Pi sessions from the native session store", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-remote-pi-sessions-"));
  await writeSession(root, "session.jsonl", [
    {
      type: "session",
      version: 3,
      id: "01TESTSESSION",
      timestamp: "2026-09-16T14:27:16.927Z",
      cwd: "/home/grimlee/pi-workspace",
    },
    {
      type: "message",
      id: "m1",
      parentId: null,
      timestamp: "2026-09-16T14:27:17.000Z",
      message: {
        role: "user",
        content: "Investigate the router",
        timestamp: 1,
      },
    },
    {
      type: "model_change",
      id: "m2",
      parentId: "m1",
      timestamp: "2026-09-16T14:27:18.000Z",
      provider: "antigravity",
      modelId: "gemini-3.8-flash",
    },
    {
      type: "session_info",
      id: "m3",
      parentId: "m2",
      timestamp: "2026-09-16T14:27:19.000Z",
      name: "Router work",
    },
  ]);

  const registry = new PiRegistry({
    sessionDir: root,
    executable: "/definitely/not/used/pi",
  });
  const sessions = await registry.listSessions();

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.instanceId, "01TESTSESSION");
  assert.equal(sessions[0]?.sessionId, "01TESTSESSION");
  assert.equal(sessions[0]?.name, "Router work");
  assert.equal(sessions[0]?.cwd, "/home/grimlee/pi-workspace");
  assert.equal(sessions[0]?.model, "antigravity/gemini-3.8-flash");
  assert.equal(sessions[0]?.startedAt, "2026-09-16T14:27:16.927Z");
  assert.equal(sessions[0]?.access, "control");
  assert.ok((sessions[0]?.generation ?? 0) > 0);
});

test("uses the first user message as a fallback session title", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-remote-pi-title-"));
  await writeSession(root, "session.jsonl", [
    {
      type: "session",
      version: 3,
      id: "01TITLE",
      timestamp: "2026-09-17T10:00:00.000Z",
      cwd: "/tmp/project",
    },
    {
      type: "message",
      id: "m1",
      parentId: null,
      timestamp: "2026-09-17T10:00:01.000Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "Fix the native Pi RPC bridge" }],
        timestamp: 1,
      },
    },
  ]);

  const [session] = await new PiRegistry({ sessionDir: root }).listSessions();
  assert.equal(session?.name, "Fix the native Pi RPC bridge");
});

test("rejects a stale generation before spawning Pi", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-remote-pi-stale-"));
  await writeSession(root, "session.jsonl", [
    {
      type: "session",
      version: 3,
      id: "01STALE",
      timestamp: "2026-09-17T11:00:00.000Z",
      cwd: "/tmp/project",
    },
  ]);

  const registry = new PiRegistry({
    sessionDir: root,
    executable: "/definitely/not/used/pi",
  });
  const [session] = await registry.listSessions();
  assert.ok(session);

  await assert.rejects(
    registry.createLink(
      session.instanceId,
      session.generation + 1,
      "control",
      { machineId: "machine_test", deviceId: "device_test" },
    ),
    (error: unknown) =>
      error instanceof PiRegistryError && error.code === "stale_generation",
  );
});
