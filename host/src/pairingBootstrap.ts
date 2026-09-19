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

export function decodePairingBootstrap(
  value: string,
): PairingBootstrap {
  const text = value.trim();
  if (!text.startsWith(PREFIX)) {
    throw new Error("invalid Pi Remote pairing bootstrap prefix");
  }

  const raw = Buffer.from(text.slice(PREFIX.length), "base64url").toString("utf8");
  const parsed: unknown = JSON.parse(raw);
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
