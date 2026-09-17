import type {
  ControlRequest,
  ControlResponse,
  MachineDescriptor,
  MachinePresence,
  MachinesSnapshot,
} from "./protocol.js";
import { PROTOCOL_VERSION } from "./protocol.js";

export interface RelayPeer {
  send(text: string): void;
  close(code?: number, reason?: string): void;
}

interface HostRecord {
  peer: RelayPeer;
  machine: MachineDescriptor;
}

interface PendingRequest {
  client: RelayPeer;
  machineId: string;
  timer: NodeJS.Timeout;
}

export class RelayRouter {
  readonly #hosts = new Map<string, HostRecord>();
  readonly #clients = new Set<RelayPeer>();
  readonly #pending = new Map<string, PendingRequest>();

  constructor(private readonly requestTimeoutMs = 15_000) {}

  registerHost(peer: RelayPeer, machine: MachineDescriptor): void {
    const previous = this.#hosts.get(machine.id);
    if (previous && previous.peer !== peer) {
      previous.peer.close(4001, "machine connection replaced");
    }

    this.#hosts.set(machine.id, { peer, machine });
    this.#broadcastPresence(machine.id, true);
  }

  removeHost(peer: RelayPeer): void {
    for (const [machineId, record] of this.#hosts) {
      if (record.peer !== peer) continue;
      this.#hosts.delete(machineId);
      this.#broadcastPresence(machineId, false);
      this.#failPendingForMachine(machineId, "machine_offline", "The machine went offline.");
    }
  }

  registerClient(peer: RelayPeer): void {
    this.#clients.add(peer);
    const snapshot: MachinesSnapshot = {
      protocolVersion: PROTOCOL_VERSION,
      type: "machines.snapshot",
      machines: [...this.#hosts.values()].map(({ machine }) => ({ ...machine, online: true })),
    };
    peer.send(JSON.stringify(snapshot));
  }

  removeClient(peer: RelayPeer): void {
    this.#clients.delete(peer);
    for (const [requestId, pending] of this.#pending) {
      if (pending.client !== peer) continue;
      clearTimeout(pending.timer);
      this.#pending.delete(requestId);
    }
  }

  routeClientRequest(client: RelayPeer, request: ControlRequest): void {
    if (this.#pending.has(request.requestId)) {
      this.#sendError(
        client,
        request,
        "invalid_request",
        "requestId is already in flight.",
      );
      return;
    }

    const host = this.#hosts.get(request.machineId);
    if (!host) {
      this.#sendError(client, request, "machine_offline", "The requested machine is offline.");
      return;
    }

    const timer = setTimeout(() => {
      const pending = this.#pending.get(request.requestId);
      if (!pending) return;
      this.#pending.delete(request.requestId);
      this.#sendError(
        pending.client,
        request,
        "timeout",
        "The host did not answer the control request in time.",
      );
    }, this.requestTimeoutMs);

    timer.unref();
    this.#pending.set(request.requestId, {
      client,
      machineId: request.machineId,
      timer,
    });
    host.peer.send(JSON.stringify(request));
  }

  routeHostResponse(hostPeer: RelayPeer, response: ControlResponse): void {
    const host = this.#hosts.get(response.machineId);
    if (!host || host.peer !== hostPeer) return;

    const pending = this.#pending.get(response.requestId);
    if (!pending || pending.machineId !== response.machineId) return;

    clearTimeout(pending.timer);
    this.#pending.delete(response.requestId);
    pending.client.send(JSON.stringify(response));
  }

  #broadcastPresence(machineId: string, online: boolean): void {
    const frame: MachinePresence = {
      protocolVersion: PROTOCOL_VERSION,
      type: "machine.presence",
      machineId,
      online,
    };
    const text = JSON.stringify(frame);
    for (const client of this.#clients) client.send(text);
  }

  #failPendingForMachine(machineId: string, code: string, message: string): void {
    for (const [requestId, pending] of this.#pending) {
      if (pending.machineId !== machineId) continue;
      clearTimeout(pending.timer);
      this.#pending.delete(requestId);
      const response: ControlResponse = {
        protocolVersion: PROTOCOL_VERSION,
        type: "control.response",
        requestId,
        machineId,
        ok: false,
        error: { code, message },
      };
      pending.client.send(JSON.stringify(response));
    }
  }

  #sendError(
    client: RelayPeer,
    request: ControlRequest,
    code: string,
    message: string,
  ): void {
    const response: ControlResponse = {
      protocolVersion: PROTOCOL_VERSION,
      type: "control.response",
      requestId: request.requestId,
      machineId: request.machineId,
      ok: false,
      error: { code, message },
    };
    client.send(JSON.stringify(response));
  }
}
