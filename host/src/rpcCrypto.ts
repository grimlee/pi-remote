import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type RpcDirection = "client" | "host";

export interface RpcRelayFrame {
  protocolVersion: 0;
  type: "rpc.frame";
  machineId: string;
  deviceId: string;
  channelId: string;
  direction: RpcDirection;
  seq: number;
  nonce: string;
  ciphertext: string;
  tag: string;
}

export interface RpcFrameContext {
  machineId: string;
  deviceId: string;
  channelId: string;
  direction: RpcDirection;
  seq: number;
}

function append(value: string, chunks: Buffer[]): void {
  chunks.push(Buffer.from(value, "utf8"), Buffer.from([0]));
}

export function rpcFrameAAD(context: RpcFrameContext): Buffer {
  const chunks = [Buffer.from("piremote-pi-rpc-frame-v1\0", "utf8")];
  append(context.machineId, chunks);
  append(context.deviceId, chunks);
  append(context.channelId, chunks);
  append(context.direction, chunks);
  chunks.push(Buffer.from(String(context.seq), "utf8"));
  return Buffer.concat(chunks);
}

export function encryptRpcPayload(
  context: RpcFrameContext,
  plaintext: Buffer,
  key: Buffer,
  nonce = randomBytes(12),
): RpcRelayFrame {
  if (key.length !== 32 || nonce.length !== 12) {
    throw new TypeError("Pi RPC channel key/nonce has invalid length");
  }
  if (!Number.isSafeInteger(context.seq) || context.seq < 1) {
    throw new TypeError("Pi RPC sequence must be a positive safe integer");
  }

  const aad = rpcFrameAAD(context);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return {
    protocolVersion: 0,
    type: "rpc.frame",
    ...context,
    nonce: nonce.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
}

export function decryptRpcPayload(frame: RpcRelayFrame, key: Buffer): Buffer {
  if (key.length !== 32) throw new TypeError("Pi RPC channel key has invalid length");
  const nonce = Buffer.from(frame.nonce, "base64url");
  const tag = Buffer.from(frame.tag, "base64url");
  if (nonce.length !== 12 || tag.length !== 16) {
    throw new TypeError("Pi RPC frame nonce/tag has invalid length");
  }

  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(rpcFrameAAD(frame));
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(Buffer.from(frame.ciphertext, "base64url")),
    decipher.final(),
  ]);
}

export function isRpcRelayFrame(value: Record<string, unknown>): value is Record<string, unknown> & RpcRelayFrame {
  return value.protocolVersion === 0
    && value.type === "rpc.frame"
    && typeof value.machineId === "string"
    && typeof value.deviceId === "string"
    && typeof value.channelId === "string"
    && (value.direction === "client" || value.direction === "host")
    && typeof value.seq === "number"
    && Number.isSafeInteger(value.seq)
    && value.seq >= 1
    && typeof value.nonce === "string"
    && typeof value.ciphertext === "string"
    && typeof value.tag === "string";
}
