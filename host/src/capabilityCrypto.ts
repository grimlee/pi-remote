import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import type { AuthorizedDevice } from "./authorizedDevices.js";
import type { MachineIdentity } from "./machineIdentity.js";
import type { SessionAccess, SessionLink } from "./types.js";

export interface EncryptedCollabCapability {
  version: 1;
  algorithm: "X25519-HKDF-SHA256-AES-256-GCM";
  machineId: string;
  deviceId: string;
  requestId: string;
  instanceId: string;
  generation: number;
  access: SessionAccess;
  salt: string;
  nonce: string;
  ciphertext: string;
  tag: string;
}

export interface CapabilityContext {
  machineId: string;
  deviceId: string;
  requestId: string;
  instanceId: string;
  generation: number;
  access: SessionAccess;
}

function field(value: string): Buffer {
  return Buffer.from(value, "utf8");
}

export function capabilityContextMessage(context: CapabilityContext): Buffer {
  return Buffer.concat([
    Buffer.from("piremote-collab-capability-v1\0", "utf8"),
    field(context.machineId), Buffer.from([0]),
    field(context.deviceId), Buffer.from([0]),
    field(context.requestId), Buffer.from([0]),
    field(context.instanceId), Buffer.from([0]),
    field(String(context.generation)), Buffer.from([0]),
    field(context.access),
  ]);
}

function machineAgreementPrivateKey(machine: MachineIdentity) {
  const key = machine.keyAgreementPrivateKey;
  return createPrivateKey({
    key: {
      kty: key.kty,
      crv: key.crv,
      x: key.x,
      d: key.d,
    },
    format: "jwk",
  });
}

function x25519PublicKey(x: string) {
  return createPublicKey({
    key: {
      kty: "OKP",
      crv: "X25519",
      x,
    },
    format: "jwk",
  });
}

function deriveKey(
  privateKey: ReturnType<typeof machineAgreementPrivateKey>,
  peerPublicKey: ReturnType<typeof x25519PublicKey>,
  salt: Buffer,
  context: Buffer,
): Buffer {
  const sharedSecret = diffieHellman({
    privateKey,
    publicKey: peerPublicKey,
  });
  return Buffer.from(
    hkdfSync("sha256", sharedSecret, salt, context, 32),
  );
}

export function encryptCollabCapability(
  machine: MachineIdentity,
  device: AuthorizedDevice,
  requestId: string,
  link: SessionLink,
): EncryptedCollabCapability {
  const context: CapabilityContext = {
    machineId: machine.id,
    deviceId: device.id,
    requestId,
    instanceId: link.instanceId,
    generation: link.generation,
    access: link.access,
  };
  const aad = capabilityContextMessage(context);
  const salt = randomBytes(32);
  const nonce = randomBytes(12);
  const key = deriveKey(
    machineAgreementPrivateKey(machine),
    x25519PublicKey(device.keyAgreementPublicKey),
    salt,
    aad,
  );

  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([
    cipher.update(link.collabUrl, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return {
    version: 1,
    algorithm: "X25519-HKDF-SHA256-AES-256-GCM",
    ...context,
    salt: salt.toString("base64url"),
    nonce: nonce.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: tag.toString("base64url"),
  };
}

export function decryptCollabCapabilityForTest(
  envelope: EncryptedCollabCapability,
  devicePrivateKeyJwk: JsonWebKey,
  machinePublicKey: string,
): string {
  const aad = capabilityContextMessage(envelope);
  const privateKey = createPrivateKey({
    key: devicePrivateKeyJwk,
    format: "jwk",
  });
  const key = deriveKey(
    privateKey,
    x25519PublicKey(machinePublicKey),
    Buffer.from(envelope.salt, "base64url"),
    aad,
  );

  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(envelope.nonce, "base64url"),
  );
  decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));

  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
