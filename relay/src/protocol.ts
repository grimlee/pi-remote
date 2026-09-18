import type { MachineGrant, HostAuthorizationDevice } from "./authorization.js";

export const PROTOCOL_VERSION = 0;

export interface MachineDescriptor {
  id: string;
  name: string;
  platform: string;
  capabilities: string[];
  signingPublicKey: string;
  keyAgreementPublicKey: string;
  fingerprint: string;
}

export interface HostHello {
  protocolVersion: 0;
  type: "host.hello";
  machine: MachineDescriptor;
}

export interface ClientHello {
  protocolVersion: 0;
  type: "client.hello";
  device: {
    id: string;
    name: string;
    signingPublicKey: string;
    keyAgreementPublicKey: string;
  };
}

export interface HostAuthorizationSnapshot {
  protocolVersion: 0;
  type: "host.authorization_snapshot";
  machineId: string;
  devices: HostAuthorizationDevice[];
}

export interface ClientAuthorizations {
  protocolVersion: 0;
  type: "client.authorizations";
  grants: MachineGrant[];
}

export interface MachinesSnapshot {
  protocolVersion: 0;
  type: "machines.snapshot";
  machines: Array<MachineDescriptor & { online: true }>;
}

export interface MachinePresence {
  protocolVersion: 0;
  type: "machine.presence";
  machineId: string;
  online: boolean;
}

export interface ControlRequest {
  protocolVersion: 0;
  type: "control.request";
  requestId: string;
  machineId: string;
  payload: Record<string, unknown>;
  authorization: {
    deviceId: string;
    issuedAtMs: number;
    signature: string;
  };
}

export interface ControlResponse {
  protocolVersion: 0;
  type: "control.response";
  requestId: string;
  machineId: string;
  ok: boolean;
  payload?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
  };
}

export function parseJsonObject(data: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(data);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function isProtocolVersion(value: unknown): value is 0 {
  return value === PROTOCOL_VERSION;
}

export function isControlRequest(value: Record<string, unknown>): value is Record<string, unknown> & ControlRequest {
  return value.type === "control.request"
    && isProtocolVersion(value.protocolVersion)
    && typeof value.requestId === "string"
    && value.requestId.length > 0
    && typeof value.machineId === "string"
    && value.machineId.length > 0
    && typeof value.payload === "object"
    && value.payload !== null
    && !Array.isArray(value.payload)
    && typeof value.authorization === "object"
    && value.authorization !== null
    && !Array.isArray(value.authorization)
    && typeof (value.authorization as Record<string, unknown>).deviceId === "string"
    && typeof (value.authorization as Record<string, unknown>).issuedAtMs === "number"
    && Number.isSafeInteger((value.authorization as Record<string, unknown>).issuedAtMs)
    && typeof (value.authorization as Record<string, unknown>).signature === "string";
}

export function isControlResponse(value: Record<string, unknown>): value is Record<string, unknown> & ControlResponse {
  return value.type === "control.response"
    && isProtocolVersion(value.protocolVersion)
    && typeof value.requestId === "string"
    && value.requestId.length > 0
    && typeof value.machineId === "string"
    && value.machineId.length > 0
    && typeof value.ok === "boolean";
}

function validPublicKey(value: unknown): value is string {
  return typeof value === "string" && value.length >= 40 && value.length <= 64;
}

export function isHostHello(value: Record<string, unknown>): value is Record<string, unknown> & HostHello {
  if (value.type !== "host.hello" || !isProtocolVersion(value.protocolVersion)) return false;
  const machine = value.machine;
  if (typeof machine !== "object" || machine === null || Array.isArray(machine)) return false;
  const record = machine as Record<string, unknown>;
  return typeof record.id === "string"
    && record.id.startsWith("machine_")
    && typeof record.name === "string"
    && record.name.length > 0
    && typeof record.platform === "string"
    && Array.isArray(record.capabilities)
    && record.capabilities.every(item => typeof item === "string")
    && validPublicKey(record.signingPublicKey)
    && validPublicKey(record.keyAgreementPublicKey)
    && typeof record.fingerprint === "string"
    && record.fingerprint.length > 0;
}

export function isClientHello(value: Record<string, unknown>): value is Record<string, unknown> & ClientHello {
  if (value.type !== "client.hello" || !isProtocolVersion(value.protocolVersion)) return false;
  const device = value.device;
  if (typeof device !== "object" || device === null || Array.isArray(device)) return false;
  const record = device as Record<string, unknown>;
  return typeof record.id === "string"
    && record.id.startsWith("device_")
    && typeof record.name === "string"
    && record.name.length > 0
    && validPublicKey(record.signingPublicKey)
    && validPublicKey(record.keyAgreementPublicKey);
}

export function isHostAuthorizationSnapshot(
  value: Record<string, unknown>,
): value is Record<string, unknown> & HostAuthorizationSnapshot {
  if (value.type !== "host.authorization_snapshot"
    || !isProtocolVersion(value.protocolVersion)
    || typeof value.machineId !== "string"
    || !Array.isArray(value.devices)) {
    return false;
  }

  return value.devices.every(item => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
    const record = item as Record<string, unknown>;
    return typeof record.id === "string"
      && record.id.startsWith("device_")
      && validPublicKey(record.signingPublicKey)
      && validPublicKey(record.keyAgreementPublicKey)
      && record.role === "owner";
  });
}

export function isClientAuthorizations(
  value: Record<string, unknown>,
): value is Record<string, unknown> & ClientAuthorizations {
  return value.type === "client.authorizations"
    && isProtocolVersion(value.protocolVersion)
    && Array.isArray(value.grants);
}
