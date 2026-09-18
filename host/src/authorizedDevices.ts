import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface AuthorizedDevice {
  id: string;
  name: string;
  signingPublicKey: string;
  keyAgreementPublicKey: string;
  role: "owner";
  pairedAt: string;
  revokedAt: string | null;
}

interface AuthorizedDeviceFile {
  version: 1;
  devices: AuthorizedDevice[];
}

function configRoot(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".config");
}

export function defaultAuthorizedDevicesPath(): string {
  return path.join(configRoot(), "pi-remote", "authorized-devices.json");
}

function validDevice(value: unknown): value is AuthorizedDevice {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string"
    && record.id.startsWith("device_")
    && typeof record.name === "string"
    && record.name.length > 0
    && typeof record.signingPublicKey === "string"
    && record.signingPublicKey.length > 0
    && typeof record.keyAgreementPublicKey === "string"
    && record.keyAgreementPublicKey.length > 0
    && record.role === "owner"
    && typeof record.pairedAt === "string"
    && (record.revokedAt === null || typeof record.revokedAt === "string");
}

async function readFile(filePath: string): Promise<AuthorizedDeviceFile> {
  try {
    const decoded: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
      throw new Error("invalid authorized device file");
    }
    const record = decoded as Record<string, unknown>;
    if (record.version !== 1 || !Array.isArray(record.devices) || !record.devices.every(validDevice)) {
      throw new Error("invalid authorized device file");
    }
    return decoded as AuthorizedDeviceFile;
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
    if (code === "ENOENT") return { version: 1, devices: [] };
    throw error;
  }
}

async function writeFileAtomic(filePath: string, value: AuthorizedDeviceFile): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.rename(tempPath, filePath);
    await fs.chmod(filePath, 0o600);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

export class AuthorizedDeviceStore {
  constructor(private readonly filePath = defaultAuthorizedDevicesPath()) {}

  async list(): Promise<AuthorizedDevice[]> {
    return (await readFile(this.filePath)).devices;
  }

  async getActive(deviceId: string): Promise<AuthorizedDevice | null> {
    const device = (await readFile(this.filePath)).devices.find(item => item.id === deviceId);
    return device && device.revokedAt === null ? device : null;
  }

  async authorize(input: Omit<AuthorizedDevice, "role" | "revokedAt">): Promise<AuthorizedDevice> {
    const file = await readFile(this.filePath);
    const existing = file.devices.find(device => device.id === input.id);

    if (existing
      && existing.revokedAt === null
      && (existing.signingPublicKey !== input.signingPublicKey
        || existing.keyAgreementPublicKey !== input.keyAgreementPublicKey)) {
      throw new Error("device id is already bound to different public keys");
    }

    const device: AuthorizedDevice = {
      ...input,
      role: "owner",
      revokedAt: null,
    };

    file.devices = file.devices.filter(item => item.id !== input.id);
    file.devices.push(device);
    await writeFileAtomic(this.filePath, file);
    return device;
  }

  async revoke(deviceId: string, revokedAt = new Date().toISOString()): Promise<boolean> {
    const file = await readFile(this.filePath);
    const index = file.devices.findIndex(item => item.id === deviceId && item.revokedAt === null);
    if (index < 0) return false;

    const device = file.devices[index];
    if (!device) return false;
    file.devices[index] = { ...device, revokedAt };
    await writeFileAtomic(this.filePath, file);
    return true;
  }
}
