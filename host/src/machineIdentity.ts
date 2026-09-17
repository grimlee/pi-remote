import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface MachineIdentity {
  id: string;
  name: string;
  platform: string;
}

function configRoot(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".config");
}

export function defaultIdentityPath(): string {
  return path.join(configRoot(), "pi-remote", "machine.json");
}

function isIdentity(value: unknown): value is MachineIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string"
    && record.id.startsWith("machine_")
    && typeof record.name === "string"
    && record.name.length > 0
    && typeof record.platform === "string"
    && record.platform.length > 0;
}

export async function loadOrCreateMachineIdentity(
  filePath = defaultIdentityPath(),
): Promise<MachineIdentity> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
    if (!isIdentity(parsed)) throw new Error("invalid Pi Remote machine identity file");
    return parsed;
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
    if (code !== "ENOENT") throw error;
  }

  const identity: MachineIdentity = {
    id: `machine_${randomUUID().replaceAll("-", "")}`,
    name: os.hostname(),
    platform: process.platform,
  };

  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, `${JSON.stringify(identity, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });

  return identity;
}
