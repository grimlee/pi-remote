import {
  createHash,
  generateKeyPairSync,
  randomUUID,
} from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export type OkpCurve = "Ed25519" | "X25519";

export interface StoredOkpPrivateKey {
  kty: "OKP";
  crv: OkpCurve;
  x: string;
  d: string;
}

export interface MachineIdentity {
  version: 2;
  id: string;
  name: string;
  platform: string;
  signingPrivateKey: StoredOkpPrivateKey;
  keyAgreementPrivateKey: StoredOkpPrivateKey;
}

export interface PublicMachineIdentity {
  id: string;
  name: string;
  platform: string;
  signingPublicKey: string;
  keyAgreementPublicKey: string;
  fingerprint: string;
}

interface LegacyMachineIdentity {
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isLegacyIdentity(value: unknown): value is LegacyMachineIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return isNonEmptyString(record.id)
    && record.id.startsWith("machine_")
    && isNonEmptyString(record.name)
    && isNonEmptyString(record.platform);
}

function isStoredOkpPrivateKey(value: unknown, curve: OkpCurve): value is StoredOkpPrivateKey {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.kty === "OKP"
    && record.crv === curve
    && isNonEmptyString(record.x)
    && isNonEmptyString(record.d);
}

function isMachineIdentity(value: unknown): value is MachineIdentity {
  if (!isLegacyIdentity(value)) return false;
  const record = value as unknown as Record<string, unknown>;
  return record.version === 2
    && isStoredOkpPrivateKey(record.signingPrivateKey, "Ed25519")
    && isStoredOkpPrivateKey(record.keyAgreementPrivateKey, "X25519");
}

function generatePrivateKey(curve: OkpCurve): StoredOkpPrivateKey {
  const algorithm = curve === "Ed25519" ? "ed25519" : "x25519";
  const { privateKey } = generateKeyPairSync(algorithm);
  const jwk = privateKey.export({ format: "jwk" });

  if (jwk.kty !== "OKP" || jwk.crv !== curve || !jwk.x || !jwk.d) {
    throw new Error(`failed to export ${curve} private key as JWK`);
  }

  return {
    kty: "OKP",
    crv: curve,
    x: jwk.x,
    d: jwk.d,
  };
}

function createIdentity(metadata?: LegacyMachineIdentity): MachineIdentity {
  return {
    version: 2,
    id: metadata?.id ?? `machine_${randomUUID().replaceAll("-", "")}`,
    name: metadata?.name ?? os.hostname(),
    platform: metadata?.platform ?? process.platform,
    signingPrivateKey: generatePrivateKey("Ed25519"),
    keyAgreementPrivateKey: generatePrivateKey("X25519"),
  };
}

async function persistIdentity(
  filePath: string,
  identity: MachineIdentity,
  exclusive: boolean,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, `${JSON.stringify(identity, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    ...(exclusive ? { flag: "wx" as const } : {}),
  });
  await fs.chmod(filePath, 0o600);
}

export function publicMachineIdentity(identity: MachineIdentity): PublicMachineIdentity {
  const signingPublicKey = identity.signingPrivateKey.x;
  const keyAgreementPublicKey = identity.keyAgreementPrivateKey.x;

  const fingerprint = createHash("sha256")
    .update("piremote-machine-v1\0", "utf8")
    .update(Buffer.from(signingPublicKey, "base64url"))
    .update(Buffer.from(keyAgreementPublicKey, "base64url"))
    .digest("base64url");

  return {
    id: identity.id,
    name: identity.name,
    platform: identity.platform,
    signingPublicKey,
    keyAgreementPublicKey,
    fingerprint,
  };
}

export async function loadOrCreateMachineIdentity(
  filePath = defaultIdentityPath(),
): Promise<MachineIdentity> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));

    if (isMachineIdentity(parsed)) return parsed;

    if (isLegacyIdentity(parsed)) {
      const upgraded = createIdentity(parsed);
      await persistIdentity(filePath, upgraded, false);
      return upgraded;
    }

    throw new Error("invalid Pi Remote machine identity file");
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;

    if (code !== "ENOENT") throw error;
  }

  const identity = createIdentity();

  try {
    await persistIdentity(filePath, identity, true);
    return identity;
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;

    if (code === "EEXIST") return loadOrCreateMachineIdentity(filePath);
    throw error;
  }
}
