import {
  authorizationSnapshotAllows,
  type HostAuthorizationDevice,
  type MachineGrant,
  verifyMachineGrant,
} from "./authorization.js";
import type { RelayAuthPrincipal } from "./auth.js";
import type {
  ClientHello,
  ControlRequest,
  ControlResponse,
  MachineDescriptor,
  MachinePresence,
  MachinesSnapshot,
  PairingRequestFrame,
  PairingResponseFrame,
  RpcFrame,
} from "./protocol.js";
import { PROTOCOL_VERSION } from "./protocol.js";

export interface RelayPeer {
  send(text: string): void;
  close(code?: number, reason?: string): void;
}

interface HostRecord {
  key: string;
  peer: RelayPeer;
  machine: MachineDescriptor;
  authorizedDevices: HostAuthorizationDevice[];
}

interface ClientRecord {
  peer: RelayPeer;
  device: ClientHello["device"];
  principal: RelayAuthPrincipal;
  grants: MachineGrant[];
  visible: Map<string, string>;
}

interface PendingRequest {
  client: RelayPeer;
  hostKey: string;
  machineId: string;
  timer: NodeJS.Timeout;
}

interface PendingPairing {
  client: RelayPeer;
  hostKey: string;
  machineId: string;
  timer: NodeJS.Timeout;
}

function hostKey(machineId: string, signingPublicKey: string): string {
  return machineId + ":" + signingPublicKey;
}

export class RelayRouter {
  readonly #hosts = new Map<string, HostRecord>();
  readonly #clients = new Map<RelayPeer, ClientRecord>();
  readonly #pending = new Map<string, PendingRequest>();
  readonly #pendingPairing = new Map<string, PendingPairing>();

  constructor(
    private readonly requestTimeoutMs = 15_000,
    private readonly pairingTimeoutMs = 15_000,
  ) {}

  registerHost(peer: RelayPeer, machine: MachineDescriptor): void {
    this.removeHost(peer);

    const key = hostKey(machine.id, machine.signingPublicKey);
    const previous = this.#hosts.get(key);
    if (previous && previous.peer !== peer) {
      previous.peer.close(4001, "machine connection replaced");
      this.removeHost(previous.peer);
    }

    this.#hosts.set(key, {
      key,
      peer,
      machine,
      authorizedDevices: [],
    });
    this.#reconcileAllClients();
  }

  setHostAuthorizationSnapshot(
    peer: RelayPeer,
    machineId: string,
    devices: HostAuthorizationDevice[],
  ): boolean {
    const host = [...this.#hosts.values()].find(
      record => record.peer === peer && record.machine.id === machineId,
    );
    if (!host) return false;

    host.authorizedDevices = devices.map(device => ({ ...device }));
    this.#reconcileAllClients();
    return true;
  }

  removeHost(peer: RelayPeer): void {
    const removedKeys: string[] = [];
    for (const [key, record] of this.#hosts) {
      if (record.peer !== peer) continue;
      this.#hosts.delete(key);
      removedKeys.push(key);
    }

    if (removedKeys.length === 0) return;

    for (const [requestId, pending] of this.#pending) {
      if (!removedKeys.includes(pending.hostKey)) continue;
      clearTimeout(pending.timer);
      this.#pending.delete(requestId);
      this.#sendErrorByFields(
        pending.client,
        requestId,
        pending.machineId,
        "machine_offline",
        "The machine went offline.",
      );
    }

    for (const [requestId, pending] of this.#pendingPairing) {
      if (!removedKeys.includes(pending.hostKey)) continue;
      clearTimeout(pending.timer);
      this.#pendingPairing.delete(requestId);
      this.#sendPairingError(
        pending.client,
        requestId,
        pending.machineId,
        "machine_offline",
        "The machine went offline.",
      );
    }

    this.#reconcileAllClients();
  }

  registerClient(
    peer: RelayPeer,
    principal: RelayAuthPrincipal,
    device: ClientHello["device"],
  ): void {
    this.removeClient(peer);
    const record: ClientRecord = {
      peer,
      principal,
      device,
      grants: [],
      visible: new Map(),
    };
    this.#clients.set(peer, record);
    this.#sendSnapshot(record);
  }

  setClientAuthorizations(peer: RelayPeer, grants: MachineGrant[]): boolean {
    const client = this.#clients.get(peer);
    if (!client) return false;

    for (const grant of grants) {
      if (!verifyMachineGrant(grant, client.principal)
        || grant.device.keyAgreementPublicKey !== client.device.keyAgreementPublicKey) {
        return false;
      }
    }

    client.grants = grants.map(grant => structuredClone(grant));
    this.#reconcileClient(client, true);
    return true;
  }

  removeClient(peer: RelayPeer): void {
    this.#clients.delete(peer);
    for (const [requestId, pending] of this.#pending) {
      if (pending.client !== peer) continue;
      clearTimeout(pending.timer);
      this.#pending.delete(requestId);
    }

    for (const [requestId, pending] of this.#pendingPairing) {
      if (pending.client !== peer) continue;
      clearTimeout(pending.timer);
      this.#pendingPairing.delete(requestId);
    }
  }

  routePairingRequest(
    clientPeer: RelayPeer,
    request: PairingRequestFrame,
  ): void {
    const client = this.#clients.get(clientPeer);
    if (!client) {
      this.#sendPairingError(
        clientPeer,
        request.requestId,
        request.machine.id,
        "unauthorized",
        "Client is not authenticated.",
      );
      return;
    }

    if (request.pairing.device.id !== client.principal.id
      || request.pairing.device.signingPublicKey !== client.principal.signingPublicKey
      || request.pairing.device.signingPublicKey !== client.device.signingPublicKey
      || request.pairing.device.keyAgreementPublicKey !== client.device.keyAgreementPublicKey) {
      this.#sendPairingError(
        clientPeer,
        request.requestId,
        request.machine.id,
        "forbidden",
        "Pairing request does not match the authenticated device.",
      );
      return;
    }

    if (this.#pendingPairing.has(request.requestId)
      || this.#pending.has(request.requestId)) {
      this.#sendPairingError(
        clientPeer,
        request.requestId,
        request.machine.id,
        "invalid_request",
        "requestId is already in flight.",
      );
      return;
    }

    const key = hostKey(
      request.machine.id,
      request.machine.signingPublicKey,
    );
    const host = this.#hosts.get(key);
    if (!host) {
      this.#sendPairingError(
        clientPeer,
        request.requestId,
        request.machine.id,
        "machine_offline",
        "The trusted pairing target is offline.",
      );
      return;
    }

    const timer = setTimeout(() => {
      const pending = this.#pendingPairing.get(request.requestId);
      if (!pending) return;
      this.#pendingPairing.delete(request.requestId);
      this.#sendPairingError(
        pending.client,
        request.requestId,
        pending.machineId,
        "timeout",
        "The host did not answer the pairing request in time.",
      );
    }, this.pairingTimeoutMs);

    timer.unref();
    this.#pendingPairing.set(request.requestId, {
      client: clientPeer,
      hostKey: key,
      machineId: request.machine.id,
      timer,
    });
    host.peer.send(JSON.stringify(request));
  }

  routePairingResponse(
    hostPeer: RelayPeer,
    response: PairingResponseFrame,
  ): void {
    const pending = this.#pendingPairing.get(response.requestId);
    if (!pending || pending.machineId !== response.machineId) return;

    const host = this.#hosts.get(pending.hostKey);
    if (!host || host.peer !== hostPeer) return;

    clearTimeout(pending.timer);
    this.#pendingPairing.delete(response.requestId);
    pending.client.send(JSON.stringify(response));
  }

  routeClientRequest(clientPeer: RelayPeer, request: ControlRequest): void {
    const client = this.#clients.get(clientPeer);
    if (!client) {
      this.#sendError(clientPeer, request, "unauthorized", "Client is not authenticated.");
      return;
    }

    if (request.authorization.deviceId !== client.principal.id) {
      this.#sendError(
        clientPeer,
        request,
        "forbidden",
        "Control request is signed for a different device.",
      );
      return;
    }

    if (this.#pending.has(request.requestId)) {
      this.#sendError(
        clientPeer,
        request,
        "invalid_request",
        "requestId is already in flight.",
      );
      return;
    }

    const grant = client.grants.find(item => item.machine.id === request.machineId);
    if (!grant) {
      this.#sendError(
        clientPeer,
        request,
        "forbidden",
        "The device has no valid grant for this machine.",
      );
      return;
    }

    const key = hostKey(grant.machine.id, grant.machine.signingPublicKey);
    const host = this.#hosts.get(key);
    if (!host) {
      this.#sendError(
        clientPeer,
        request,
        "machine_offline",
        "The trusted machine is offline.",
      );
      return;
    }

    if (!authorizationSnapshotAllows(host.authorizedDevices, grant)) {
      this.#sendError(
        clientPeer,
        request,
        "forbidden",
        "The host no longer authorizes this device.",
      );
      return;
    }

    const timer = setTimeout(() => {
      const pending = this.#pending.get(request.requestId);
      if (!pending) return;
      this.#pending.delete(request.requestId);
      this.#sendErrorByFields(
        pending.client,
        request.requestId,
        request.machineId,
        "timeout",
        "The host did not answer the control request in time.",
      );
    }, this.requestTimeoutMs);

    timer.unref();
    this.#pending.set(request.requestId, {
      client: clientPeer,
      hostKey: key,
      machineId: request.machineId,
      timer,
    });
    host.peer.send(JSON.stringify(request));
  }

  routeHostResponse(hostPeer: RelayPeer, response: ControlResponse): void {
    const pending = this.#pending.get(response.requestId);
    if (!pending || pending.machineId !== response.machineId) return;

    const host = this.#hosts.get(pending.hostKey);
    if (!host || host.peer !== hostPeer) return;

    clearTimeout(pending.timer);
    this.#pending.delete(response.requestId);
    pending.client.send(JSON.stringify(response));
  }

  routeRpcFrame(peer: RelayPeer, frame: RpcFrame): void {
    if (frame.direction === "client") {
      const client = this.#clients.get(peer);
      if (!client
        || client.principal.id !== frame.deviceId
        || client.device.id !== frame.deviceId) {
        return;
      }

      const grant = client.grants.find(item => item.machine.id === frame.machineId);
      if (!grant) return;
      const key = hostKey(grant.machine.id, grant.machine.signingPublicKey);
      const host = this.#hosts.get(key);
      if (!host || !authorizationSnapshotAllows(host.authorizedDevices, grant)) return;
      host.peer.send(JSON.stringify(frame));
      return;
    }

    const host = [...this.#hosts.values()].find(
      item => item.peer === peer && item.machine.id === frame.machineId,
    );
    if (!host) return;

    const hostDevice = host.authorizedDevices.find(item => item.id === frame.deviceId);
    if (!hostDevice) return;

    for (const client of this.#clients.values()) {
      if (client.principal.id !== frame.deviceId || client.device.id !== frame.deviceId) continue;
      const grant = client.grants.find(item =>
        item.machine.id === frame.machineId
        && item.device.id === frame.deviceId
      );
      if (!grant) continue;
      const key = hostKey(grant.machine.id, grant.machine.signingPublicKey);
      if (key !== host.key || !authorizationSnapshotAllows(host.authorizedDevices, grant)) continue;
      client.peer.send(JSON.stringify(frame));
    }
  }

  #authorizedHosts(client: ClientRecord): Map<string, HostRecord> {
    const result = new Map<string, HostRecord>();

    for (const grant of client.grants) {
      const key = hostKey(grant.machine.id, grant.machine.signingPublicKey);
      const host = this.#hosts.get(key);
      if (!host) continue;
      if (!authorizationSnapshotAllows(host.authorizedDevices, grant)) continue;
      result.set(grant.machine.id, host);
    }

    return result;
  }

  #sendSnapshot(client: ClientRecord): void {
    const hosts = this.#authorizedHosts(client);
    client.visible = new Map(
      [...hosts].map(([machineId, host]) => [machineId, host.key]),
    );

    const snapshot: MachinesSnapshot = {
      protocolVersion: PROTOCOL_VERSION,
      type: "machines.snapshot",
      machines: [...hosts.values()].map(({ machine }) => ({
        ...machine,
        online: true,
      })),
    };
    client.peer.send(JSON.stringify(snapshot));
  }

  #reconcileAllClients(): void {
    for (const client of this.#clients.values()) {
      this.#reconcileClient(client, false);
    }
  }

  #reconcileClient(client: ClientRecord, forceSnapshot: boolean): void {
    const hosts = this.#authorizedHosts(client);
    const nextVisible = new Map(
      [...hosts].map(([machineId, host]) => [machineId, host.key]),
    );

    let changed = forceSnapshot;
    const presence: MachinePresence[] = [];

    for (const [machineId, key] of client.visible) {
      if (nextVisible.get(machineId) === key) continue;
      changed = true;
      presence.push({
        protocolVersion: PROTOCOL_VERSION,
        type: "machine.presence",
        machineId,
        online: false,
      });
    }

    for (const [machineId, key] of nextVisible) {
      if (client.visible.get(machineId) === key) continue;
      changed = true;
      presence.push({
        protocolVersion: PROTOCOL_VERSION,
        type: "machine.presence",
        machineId,
        online: true,
      });
    }

    if (!changed) return;

    client.visible = nextVisible;
    const snapshot: MachinesSnapshot = {
      protocolVersion: PROTOCOL_VERSION,
      type: "machines.snapshot",
      machines: [...hosts.values()].map(({ machine }) => ({
        ...machine,
        online: true,
      })),
    };
    client.peer.send(JSON.stringify(snapshot));
    for (const frame of presence) client.peer.send(JSON.stringify(frame));
  }

  #sendPairingError(
    client: RelayPeer,
    requestId: string,
    machineId: string,
    code: string,
    message: string,
  ): void {
    const response: PairingResponseFrame = {
      protocolVersion: PROTOCOL_VERSION,
      type: "pairing.response",
      requestId,
      machineId,
      ok: false,
      error: { code, message },
    };
    client.send(JSON.stringify(response));
  }

  #sendError(
    client: RelayPeer,
    request: ControlRequest,
    code: string,
    message: string,
  ): void {
    this.#sendErrorByFields(
      client,
      request.requestId,
      request.machineId,
      code,
      message,
    );
  }

  #sendErrorByFields(
    client: RelayPeer,
    requestId: string,
    machineId: string,
    code: string,
    message: string,
  ): void {
    const response: ControlResponse = {
      protocolVersion: PROTOCOL_VERSION,
      type: "control.response",
      requestId,
      machineId,
      ok: false,
      error: { code, message },
    };
    client.send(JSON.stringify(response));
  }
}
