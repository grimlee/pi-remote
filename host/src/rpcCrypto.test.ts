import assert from "node:assert/strict";
import test from "node:test";
import { decryptRpcPayload, encryptRpcPayload, rpcFrameAAD } from "./rpcCrypto.js";

test("Pi RPC frame AES-GCM round trip and AAD binding", () => {
  const key = Buffer.alloc(32, 0x44);
  const nonce = Buffer.alloc(12, 0x66);
  const context = {
    machineId: "machine_testvector",
    deviceId: "device_testvector",
    channelId: "rpc_testvector",
    direction: "client" as const,
    seq: 7,
  };

  const frame = encryptRpcPayload(
    context,
    Buffer.from('{"id":"req-1","type":"get_state"}'),
    key,
    nonce,
  );

  assert.equal(
    rpcFrameAAD(context).toString("base64url"),
    "cGlyZW1vdGUtcGktcnBjLWZyYW1lLXYxAG1hY2hpbmVfdGVzdHZlY3RvcgBkZXZpY2VfdGVzdHZlY3RvcgBycGNfdGVzdHZlY3RvcgBjbGllbnQANw",
  );
  assert.equal(frame.nonce, "ZmZmZmZmZmZmZmZm");
  assert.equal(
    decryptRpcPayload(frame, key).toString("utf8"),
    '{"id":"req-1","type":"get_state"}',
  );

  assert.throws(() => decryptRpcPayload({ ...frame, seq: 8 }, key));
});
