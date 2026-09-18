import type { PairingInvitation } from "./pairing.js";

export interface PairingBootstrap {
  version: 1;
  relayUrl: string;
  invitation: PairingInvitation;
}

const PREFIX = "piremote-pair-v1.";

export function relayClientUrl(hostUrl: string): string {
  const url = new URL(hostUrl);
  if (url.pathname === "/v0/host") {
    url.pathname = "/v0/client";
  } else {
    url.pathname = "/v0/client";
  }
  return url.toString();
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

  return parsed as PairingBootstrap;
}
