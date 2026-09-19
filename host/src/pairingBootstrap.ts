import { deflateSync, inflateSync } from "node:zlib";
import type { PairingInvitation } from "./pairing.js";

export interface RelayPairingTransport {
  kind: "relay";
}

export interface TailcatPairingTransport {
  kind: "tailcat";
  address: string;
  remotePort: number;
}

export type PairingTransport =
  | RelayPairingTransport
  | TailcatPairingTransport;

export interface PairingBootstrap {
  version: 1;
  relayUrl: string;
  transport?: PairingTransport;
  invitation: PairingInvitation;
}

const PREFIX = "piremote-pair-v1.";
const COMPRESSED_PREFIX = "piremote-pair-v1z.";
const MAX_BOOTSTRAP_BYTES = 64 * 1024;

export function relayClientUrl(hostUrl: string): string {
  const url = new URL(hostUrl);
  url.pathname = "/v0/client";
  return url.toString();
}

function parseTransport(value: unknown): PairingTransport | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid Pi Remote pairing transport");
  }

  const record = value as Record<string, unknown>;
  if (record.kind === "relay") {
    return { kind: "relay" };
  }

  if (record.kind === "tailcat"
    && typeof record.address === "string"
    && record.address.startsWith("tc")
    && record.address.length >= 20
    && typeof record.remotePort === "number"
    && Number.isInteger(record.remotePort)
    && record.remotePort >= 1
    && record.remotePort <= 65_535) {
    return {
      kind: "tailcat",
      address: record.address,
      remotePort: record.remotePort,
    };
  }

  throw new Error("invalid Pi Remote pairing transport");
}

export function encodePairingBootstrap(
  bootstrap: PairingBootstrap,
): string {
  return PREFIX
    + Buffer.from(JSON.stringify(bootstrap), "utf8").toString("base64url");
}

export function encodeCompressedPairingBootstrap(
  bootstrap: PairingBootstrap,
): string {
  const raw = Buffer.from(JSON.stringify(bootstrap), "utf8");
  const compressed = deflateSync(raw, { level: 9 });
  return COMPRESSED_PREFIX + compressed.toString("base64url");
}

export function decodePairingBootstrap(
  value: string,
): PairingBootstrap {
  const text = value.trim();

  let raw: Buffer;
  if (text.startsWith(COMPRESSED_PREFIX)) {
    const compressed = Buffer.from(
      text.slice(COMPRESSED_PREFIX.length),
      "base64url",
    );
    raw = inflateSync(compressed, {
      maxOutputLength: MAX_BOOTSTRAP_BYTES,
    });
  } else if (text.startsWith(PREFIX)) {
    raw = Buffer.from(text.slice(PREFIX.length), "base64url");
  } else {
    throw new Error("invalid Pi Remote pairing bootstrap prefix");
  }

  if (raw.length === 0 || raw.length > MAX_BOOTSTRAP_BYTES) {
    throw new Error("invalid Pi Remote pairing bootstrap size");
  }

  const parsed: unknown = JSON.parse(raw.toString("utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("invalid Pi Remote pairing bootstrap");
  }

  const record = parsed as Record<string, unknown>;
  if (record.version !== 1 || typeof record.relayUrl !== "string") {
    throw new Error("invalid Pi Remote pairing bootstrap");
  }

  const invitation = record.invitation;
  if (typeof invitation !== "object" || invitation === null || Array.isArray(invitation)) {
    throw new Error("invalid Pi Remote pairing invitation");
  }

  const transport = parseTransport(record.transport);
  return {
    version: 1,
    relayUrl: record.relayUrl,
    ...(transport ? { transport } : {}),
    invitation: invitation as PairingInvitation,
  };
}
