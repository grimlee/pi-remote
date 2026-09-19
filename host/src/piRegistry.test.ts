import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PiRegistry, PiRegistryError } from "./piRegistry.js";
import { decryptRpcPayload, encryptRpcPayload } from "./rpcCrypto.js";

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
      cwd: "/home/testuser/pi-workspace",
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
  assert.equal(sessions[0]?.cwd, "/home/testuser/pi-workspace");
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


test("bridges encrypted mobile commands to a Pi RPC subprocess", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-remote-pi-rpc-"));
  await writeSession(root, "session.jsonl", [
    {
      type: "session",
      version: 3,
      id: "01RPCBRIDGE",
      timestamp: "2026-09-18T12:00:00.000Z",
      cwd: root,
    },
    {
      type: "message",
      id: "m1",
      parentId: null,
      timestamp: "2026-09-18T12:00:01.000Z",
      message: { role: "user", content: "hello", timestamp: 1 },
    },
  ]);

  const fakePi = path.join(root, "fake-pi.mjs");
  await writeFile(fakePi, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({type:"ready",protocolVersion:1})+"\\n");
let buffer="";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk;
  while (buffer.includes("\\n")) {
    const index = buffer.indexOf("\\n");
    const line = buffer.slice(0,index);
    buffer = buffer.slice(index+1);
    if (!line) continue;
    const command = JSON.parse(line);
    if (command.type === "get_state") {
      process.stdout.write(JSON.stringify({
        id: command.id,
        type: "response",
        command: "get_state",
        success: true,
        data: { sessionId: "01RPCBRIDGE", isStreaming: false }
      })+"\\n");
    }
  }
});
`);
  await chmod(fakePi, 0o755);

  const registry = new PiRegistry({
    sessionDir: root,
    executable: fakePi,
    idleTimeoutMs: 5_000,
  });
  const [session] = await registry.listSessions();
  assert.ok(session);

  let resolveResponse!: (value: Record<string, unknown>) => void;
  const response = new Promise<Record<string, unknown>>((resolve, reject) => {
    resolveResponse = resolve;
    const timer = setTimeout(() => reject(new Error("timed out waiting for Pi RPC response")), 3_000);
    timer.unref();
  });

  let capabilityKey: Buffer | null = null;
  registry.setOutboundFrameHandler(frame => {
    if (!capabilityKey) return;
    const decoded = JSON.parse(
      decryptRpcPayload(frame, capabilityKey).toString("utf8"),
    ) as Record<string, unknown>;
    if (decoded.type === "response" && decoded.command === "get_state") {
      resolveResponse(decoded);
    }
  });

  const link = await registry.createLink(
    session.instanceId,
    session.generation,
    "control",
    { machineId: "machine_test", deviceId: "device_test" },
  );
  const capability = JSON.parse(link.collabUrl) as {
    channelId: string;
    key: string;
  };
  capabilityKey = Buffer.from(capability.key, "base64url");

  registry.handleRpcFrame(encryptRpcPayload(
    {
      machineId: "machine_test",
      deviceId: "device_test",
      channelId: capability.channelId,
      direction: "client",
      seq: 1,
    },
    Buffer.from(JSON.stringify({ id: "req-state", type: "get_state" })),
    capabilityKey,
  ));

  const decoded = await response;
  assert.equal(decoded.success, true);
  assert.equal(decoded.command, "get_state");
  assert.deepEqual(decoded.data, {
    sessionId: "01RPCBRIDGE",
    isStreaming: false,
  });

  registry.stop();
});
