export const PROTOCOL_VERSION = 0;

export interface MachineDescriptor {
  id: string;
  name: string;
  platform: string;
  capabilities: string[];
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
  };
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

export type HostInboundFrame = HostHello | ControlResponse;
export type ClientInboundFrame = ClientHello | ControlRequest;

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
    && !Array.isArray(value.payload);
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

export function isHostHello(value: Record<string, unknown>): value is Record<string, unknown> & HostHello {
  if (value.type !== "host.hello" || !isProtocolVersion(value.protocolVersion)) return false;
  const machine = value.machine;
  if (typeof machine !== "object" || machine === null || Array.isArray(machine)) return false;
  const record = machine as Record<string, unknown>;
  return typeof record.id === "string"
    && record.id.length > 0
    && typeof record.name === "string"
    && record.name.length > 0
    && typeof record.platform === "string"
    && Array.isArray(record.capabilities)
    && record.capabilities.every(item => typeof item === "string");
}

export function isClientHello(value: Record<string, unknown>): value is Record<string, unknown> & ClientHello {
  if (value.type !== "client.hello" || !isProtocolVersion(value.protocolVersion)) return false;
  const device = value.device;
  if (typeof device !== "object" || device === null || Array.isArray(device)) return false;
  const record = device as Record<string, unknown>;
  return typeof record.id === "string"
    && record.id.length > 0
    && typeof record.name === "string"
    && record.name.length > 0;
}
