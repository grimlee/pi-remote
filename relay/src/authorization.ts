import { createPublicKey, verify } from "node:crypto";
import type { RelayAuthPrincipal } from "./auth.js";

export interface MachineGrant {
  version: 1;
  grantId: string;
  machine: {
    id: string;
    signingPublicKey: string;
    keyAgreementPublicKey: string;
  };
  device: {
    id: string;
    signingPublicKey: string;
    keyAgreementPublicKey: string;
  };
  role: "owner";
  issuedAt: string;
  signature: string;
}

export interface HostAuthorizationDevice {
  id: string;
  signingPublicKey: string;
  keyAgreementPublicKey: string;
  role: "owner";
}

function field(value: string): Buffer {
  return Buffer.from(value, "utf8");
}

export function machineGrantMessage(grant: Omit<MachineGrant, "signature">): Buffer {
  return Buffer.concat([
    Buffer.from("piremote-machine-grant-v1\0", "utf8"),
    field(grant.grantId), Buffer.from([0]),
    field(grant.machine.id), Buffer.from([0]),
    field(grant.machine.signingPublicKey), Buffer.from([0]),
    field(grant.machine.keyAgreementPublicKey), Buffer.from([0]),
    field(grant.device.id), Buffer.from([0]),
    field(grant.device.signingPublicKey), Buffer.from([0]),
    field(grant.device.keyAgreementPublicKey), Buffer.from([0]),
    field(grant.role), Buffer.from([0]),
    field(grant.issuedAt),
  ]);
}

export function verifyMachineGrant(
  grant: MachineGrant,
  devicePrincipal?: RelayAuthPrincipal,
): boolean {
  if (grant.version !== 1
    || !grant.grantId.startsWith("grant_")
    || !grant.machine.id.startsWith("machine_")
    || !grant.device.id.startsWith("device_")
    || grant.role !== "owner"
    || !Number.isFinite(Date.parse(grant.issuedAt))) {
    return false;
  }

  if (devicePrincipal) {
    if (devicePrincipal.kind !== "device"
      || devicePrincipal.id !== grant.device.id
      || devicePrincipal.signingPublicKey !== grant.device.signingPublicKey) {
      return false;
    }
  }

  try {
    const publicKey = createPublicKey({
      key: {
        kty: "OKP",
        crv: "Ed25519",
        x: grant.machine.signingPublicKey,
      },
      format: "jwk",
    });
    const { signature, ...unsigned } = grant;

    return verify(
      null,
      machineGrantMessage(unsigned),
      publicKey,
      Buffer.from(signature, "base64url"),
    );
  } catch {
    return false;
  }
}

export function authorizationSnapshotAllows(
  devices: readonly HostAuthorizationDevice[],
  grant: MachineGrant,
): boolean {
  return devices.some(device =>
    device.id === grant.device.id
    && device.signingPublicKey === grant.device.signingPublicKey
    && device.keyAgreementPublicKey === grant.device.keyAgreementPublicKey
    && device.role === grant.role
  );
}
