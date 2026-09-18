import {
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import type { PairingDevicePublicIdentity } from "./pairing.js";
import type { MachineIdentity } from "./machineIdentity.js";

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

export type UnsignedMachineGrant = Omit<MachineGrant, "signature">;

function field(value: string): Buffer {
  return Buffer.from(value, "utf8");
}

export function machineGrantMessage(grant: UnsignedMachineGrant): Buffer {
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

export function issueMachineGrant(
  machine: MachineIdentity,
  device: PairingDevicePublicIdentity,
  issuedAt: string,
  grantId = "grant_" + randomUUID().replaceAll("-", ""),
): MachineGrant {
  const unsigned: UnsignedMachineGrant = {
    version: 1,
    grantId,
    machine: {
      id: machine.id,
      signingPublicKey: machine.signingPrivateKey.x,
      keyAgreementPublicKey: machine.keyAgreementPrivateKey.x,
    },
    device: {
      id: device.id,
      signingPublicKey: device.signingPublicKey,
      keyAgreementPublicKey: device.keyAgreementPublicKey,
    },
    role: "owner",
    issuedAt,
  };

  const key = machine.signingPrivateKey;
  const privateKey = createPrivateKey({
    key: {
      kty: key.kty,
      crv: key.crv,
      x: key.x,
      d: key.d,
    },
    format: "jwk",
  });

  return {
    ...unsigned,
    signature: sign(null, machineGrantMessage(unsigned), privateKey).toString("base64url"),
  };
}

export function verifyMachineGrant(grant: MachineGrant): boolean {
  if (grant.version !== 1
    || !grant.grantId.startsWith("grant_")
    || !grant.machine.id.startsWith("machine_")
    || !grant.device.id.startsWith("device_")
    || grant.role !== "owner") {
    return false;
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
