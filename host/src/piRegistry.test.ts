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
  let resolveAck!: (value: Record<string, unknown>) => void;
  const clientAck = new Promise<Record<string, unknown>>((resolve, reject) => {
    resolveAck = resolve;
    const timer = setTimeout(() => reject(new Error("timed out waiting for Pi Remote client ACK")), 3_000);
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
    if (decoded.type === "piremote.client_ack"
      && decoded.commandId === "req-state") {
      resolveAck(decoded);
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
    nextClientSeq: number;
    lastHostSeq: number;
    resumeToken: string;
    resumeTargetHostSeq: number;
  };
  assert.equal(capability.nextClientSeq, 1);
  assert.ok(capability.lastHostSeq >= 0);
  capabilityKey = Buffer.from(capability.key, "base64url");

  registry.handleRpcFrame(encryptRpcPayload(
    {
      machineId: "machine_test",
      deviceId: "device_test",
      channelId: capability.channelId,
      direction: "client",
      seq: 1,
    },
    Buffer.from(JSON.stringify({
      type: "piremote.resume_ack",
      resumeToken: capability.resumeToken,
      hostSeq: capability.resumeTargetHostSeq,
    })),
    capabilityKey,
  ));

  registry.handleRpcFrame(encryptRpcPayload(
    {
      machineId: "machine_test",
      deviceId: "device_test",
      channelId: capability.channelId,
      direction: "client",
      seq: 2,
    },
    Buffer.from(JSON.stringify({ id: "req-state", type: "get_state" })),
    capabilityKey,
  ));

  const [decoded, ack] = await Promise.all([response, clientAck]);
  assert.equal(ack.clientSeq, 2);
  assert.equal(ack.commandId, "req-state");
  assert.equal(decoded.success, true);
  assert.equal(decoded.command, "get_state");
  assert.deepEqual(decoded.data, {
    sessionId: "01RPCBRIDGE",
    isStreaming: false,
  });

  const resumedLink = await registry.createLink(
    session.instanceId,
    session.generation,
    "control",
    { machineId: "machine_test", deviceId: "device_test" },
  );
  const resumedCapability = JSON.parse(resumedLink.collabUrl) as {
    channelId: string;
    key: string;
    nextClientSeq: number;
    lastHostSeq: number;
  };

  assert.equal(resumedCapability.channelId, capability.channelId);
  assert.equal(resumedCapability.key, capability.key);
  assert.equal(resumedCapability.nextClientSeq, 3);
  assert.ok(resumedCapability.lastHostSeq >= capability.lastHostSeq);

  registry.stop();
});


test("replays missed RPC frames before releasing post-resume live output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-remote-pi-replay-"));
  await writeSession(root, "session.jsonl", [
    {
      type: "session",
      version: 3,
      id: "01REPLAY",
      timestamp: "2026-09-19T00:00:00.000Z",
      cwd: root,
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
    if (command.type === "emit_test") {
      process.stdout.write(JSON.stringify({
        type: "test_event",
        label: command.label
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
    resumeBarrierTimeoutMs: 5_000,
  });
  const [session] = await registry.listSessions();
  assert.ok(session);

  const rawOutbound: ReturnType<typeof encryptRpcPayload>[] = [];
  const outbound: Array<{
    frame: ReturnType<typeof encryptRpcPayload>;
    value: Record<string, unknown>;
  }> = [];
  let key: Buffer | null = null;

  registry.setOutboundFrameHandler(frame => {
    rawOutbound.push(frame);
    if (!key) return;
    outbound.push({
      frame,
      value: JSON.parse(
        decryptRpcPayload(frame, key).toString("utf8"),
      ) as Record<string, unknown>,
    });
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
    nextClientSeq: number;
    resumeToken: string;
    resumeTargetHostSeq: number;
  };
  key = Buffer.from(capability.key, "base64url");

  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(
    rawOutbound.length,
    0,
    "initial Pi frames must remain behind the link barrier",
  );

  let clientSeq = capability.nextClientSeq;
  const send = (value: Record<string, unknown>) => {
    registry.handleRpcFrame(encryptRpcPayload(
      {
        machineId: "machine_test",
        deviceId: "device_test",
        channelId: capability.channelId,
        direction: "client",
        seq: clientSeq++,
      },
      Buffer.from(JSON.stringify(value)),
      key!,
    ));
  };

  const waitForLabel = async (label: string) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const match = outbound.find(item => item.value.label === label);
      if (match) return match;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail(`timed out waiting for ${label}`);
  };

  send({
    type: "piremote.resume_ack",
    resumeToken: capability.resumeToken,
    hostSeq: capability.resumeTargetHostSeq,
  });
  send({ type: "emit_test", label: "A" });
  const eventA = await waitForLabel("A");
  send({ type: "emit_test", label: "B" });
  const eventB = await waitForLabel("B");
  assert.ok(eventB.frame.seq > eventA.frame.seq);

  const resumedLink = await registry.createLink(
    session.instanceId,
    session.generation,
    "control",
    {
      machineId: "machine_test",
      deviceId: "device_test",
      resumeFromHostSeq: eventA.frame.seq,
    },
  );
  const resumed = JSON.parse(resumedLink.collabUrl) as {
    nextClientSeq: number;
    resumeToken: string;
    resumeTargetHostSeq: number;
    replayAvailable: boolean;
  };

  assert.equal(resumed.replayAvailable, true);
  assert.ok(resumed.resumeTargetHostSeq >= eventB.frame.seq);
  assert.deepEqual(
    resumedLink.replayFrames.map(frame => frame.seq),
    Array.from(
      {
        length:
          resumed.resumeTargetHostSeq - eventA.frame.seq,
      },
      (_, index) => eventA.frame.seq + index + 1,
    ),
  );

  clientSeq = resumed.nextClientSeq;
  send({ type: "emit_test", label: "C" });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(
    outbound.some(item => item.value.label === "C"),
    false,
  );

  send({
    type: "piremote.resume_ack",
    resumeToken: resumed.resumeToken,
    hostSeq: resumed.resumeTargetHostSeq,
  });
  const eventC = await waitForLabel("C");
  assert.ok(eventC.frame.seq > resumed.resumeTargetHostSeq);
  assert.deepEqual(
    outbound
      .filter(item =>
        item.frame.seq > resumed.resumeTargetHostSeq
        && item.frame.seq <= eventC.frame.seq
      )
      .map(item => item.frame.seq),
    Array.from(
      {
        length:
          eventC.frame.seq - resumed.resumeTargetHostSeq,
      },
      (_, index) =>
        resumed.resumeTargetHostSeq + index + 1,
    ),
  );

  registry.stop();
});

test("falls back to snapshot reconciliation when replay cursor is outside the ring", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-remote-pi-replay-gap-"));
  await writeSession(root, "session.jsonl", [
    {
      type: "session",
      version: 3,
      id: "01REPLAYGAP",
      timestamp: "2026-09-19T00:00:00.000Z",
      cwd: root,
    },
  ]);

  const fakePi = path.join(root, "fake-pi.mjs");
  await writeFile(fakePi, `#!/usr/bin/env node
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
    if (command.type === "emit_test") {
      process.stdout.write(JSON.stringify({
        type: "test_event",
        label: command.label
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
    maxReplayFrames: 1,
    maxReplayBytes: 1024 * 1024,
    resumeBarrierTimeoutMs: 5_000,
  });
  const [session] = await registry.listSessions();
  assert.ok(session);

  const outbound: Array<{
    frame: ReturnType<typeof encryptRpcPayload>;
    value: Record<string, unknown>;
  }> = [];
  let key: Buffer | null = null;
  registry.setOutboundFrameHandler(frame => {
    if (!key) return;
    outbound.push({
      frame,
      value: JSON.parse(
        decryptRpcPayload(frame, key).toString("utf8"),
      ) as Record<string, unknown>,
    });
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
    nextClientSeq: number;
    resumeToken: string;
    resumeTargetHostSeq: number;
  };
  key = Buffer.from(capability.key, "base64url");

  let clientSeq = capability.nextClientSeq;
  const send = (label: string) => {
    registry.handleRpcFrame(encryptRpcPayload(
      {
        machineId: "machine_test",
        deviceId: "device_test",
        channelId: capability.channelId,
        direction: "client",
        seq: clientSeq++,
      },
      Buffer.from(JSON.stringify({
        type: "emit_test",
        label,
      })),
      key!,
    ));
  };

  registry.handleRpcFrame(encryptRpcPayload(
    {
      machineId: "machine_test",
      deviceId: "device_test",
      channelId: capability.channelId,
      direction: "client",
      seq: clientSeq++,
    },
    Buffer.from(JSON.stringify({
      type: "piremote.resume_ack",
      resumeToken: capability.resumeToken,
      hostSeq: capability.resumeTargetHostSeq,
    })),
    key,
  ));

  send("A");
  send("B");

  let eventA:
    | {
        frame: ReturnType<typeof encryptRpcPayload>;
        value: Record<string, unknown>;
      }
    | undefined;
  let eventB:
    | {
        frame: ReturnType<typeof encryptRpcPayload>;
        value: Record<string, unknown>;
      }
    | undefined;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    eventA = outbound.find(item => item.value.label === "A");
    eventB = outbound.find(item => item.value.label === "B");
    if (eventA && eventB) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(eventA);
  assert.ok(eventB);

  const resumedLink = await registry.createLink(
    session.instanceId,
    session.generation,
    "control",
    {
      machineId: "machine_test",
      deviceId: "device_test",
      resumeFromHostSeq: eventA.frame.seq - 1,
    },
  );
  const resumed = JSON.parse(resumedLink.collabUrl) as {
    replayAvailable: boolean;
    resumeToken: string;
    resumeTargetHostSeq: number;
    nextClientSeq: number;
  };

  assert.equal(resumed.replayAvailable, false);
  assert.deepEqual(resumedLink.replayFrames, []);

  clientSeq = resumed.nextClientSeq;
  registry.handleRpcFrame(encryptRpcPayload(
    {
      machineId: "machine_test",
      deviceId: "device_test",
      channelId: capability.channelId,
      direction: "client",
      seq: clientSeq,
    },
    Buffer.from(JSON.stringify({
      type: "piremote.resume_ack",
      resumeToken: resumed.resumeToken,
      hostSeq: resumed.resumeTargetHostSeq,
    })),
    key,
  ));

  registry.stop();
});


test("deduplicates retried RPC commands by command id", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-remote-pi-dedupe-"));
  await writeSession(root, "session.jsonl", [
    {
      type: "session",
      version: 3,
      id: "01DEDUPE",
      timestamp: "2026-09-19T00:00:00.000Z",
      cwd: root,
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
    if (command.type === "prompt") {
      process.stdout.write(JSON.stringify({
        type: "test_event",
        commandId: command.id
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
    resumeBarrierTimeoutMs: 5_000,
  });
  const [session] = await registry.listSessions();
  assert.ok(session);

  const outbound: Array<Record<string, unknown>> = [];
  let key: Buffer | null = null;
  registry.setOutboundFrameHandler(frame => {
    if (!key) return;
    outbound.push(JSON.parse(
      decryptRpcPayload(frame, key).toString("utf8"),
    ) as Record<string, unknown>);
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
    nextClientSeq: number;
    resumeToken: string;
    resumeTargetHostSeq: number;
  };
  key = Buffer.from(capability.key, "base64url");

  const send = (seq: number, value: Record<string, unknown>) => {
    registry.handleRpcFrame(encryptRpcPayload(
      {
        machineId: "machine_test",
        deviceId: "device_test",
        channelId: capability.channelId,
        direction: "client",
        seq,
      },
      Buffer.from(JSON.stringify(value)),
      key!,
    ));
  };

  send(capability.nextClientSeq, {
    type: "piremote.resume_ack",
    resumeToken: capability.resumeToken,
    hostSeq: capability.resumeTargetHostSeq,
  });

  send(capability.nextClientSeq + 1, {
    id: "prompt-duplicate-test",
    type: "prompt",
    message: "hello",
  });

  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (outbound.some(value =>
      value.type === "test_event"
      && value.commandId === "prompt-duplicate-test"
    )) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  send(capability.nextClientSeq + 2, {
    id: "prompt-duplicate-test",
    type: "prompt",
    message: "hello",
  });

  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (outbound.some(value =>
      value.type === "piremote.client_ack"
      && value.clientSeq === capability.nextClientSeq + 2
      && value.duplicate === true
    )) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  await new Promise(resolve => setTimeout(resolve, 100));

  const events = outbound.filter(value =>
    value.type === "test_event"
    && value.commandId === "prompt-duplicate-test"
  );
  assert.equal(events.length, 1);

  const duplicateAck = outbound.find(value =>
    value.type === "piremote.client_ack"
    && value.clientSeq === capability.nextClientSeq + 2
  );
  assert.equal(duplicateAck?.duplicate, true);

  registry.stop();
});
