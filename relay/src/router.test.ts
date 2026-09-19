import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import {
  machineGrantMessage,
  type HostAuthorizationDevice,
  type MachineGrant,
} from "./authorization.js";
import type { RelayAuthPrincipal } from "./auth.js";
import type {
  ClientHello,
  ControlRequest,
  ControlResponse,
  MachineDescriptor,
  RpcFrame,
} from "./protocol.js";
import type { RelayPeer } from "./router.js";
import { RelayRouter } from "./router.js";

class FakePeer implements RelayPeer {
  readonly sent: string[] = [];
  closed: { code: number | undefined; reason: string | undefined } | null = null;

  constructor(readonly id: string = "fake-peer") {}

  send(text: string): void {
    this.sent.push(text);
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
}

function okpPublicKey(type: "ed25519" | "x25519") {
  const key = type === "ed25519"
    ? generateKeyPairSync("ed25519")
    : generateKeyPairSync("x25519");
  const publicJwk = key.publicKey.export({ format: "jwk" });
  assert.equal(publicJwk.kty, "OKP");
  assert.ok(publicJwk.x);
  return { key, x: publicJwk.x };
}

function fixture(machineId = "machine_test") {
  const machineSigning = okpPublicKey("ed25519");
  const machineAgreement = okpPublicKey("x25519");
  const deviceSigning = okpPublicKey("ed25519");
  const deviceAgreement = okpPublicKey("x25519");

  const machine: MachineDescriptor = {
    id: machineId,
    name: "omarchy",
    platform: "linux",
    capabilities: ["sessions.list", "sessions.link"],
    signingPublicKey: machineSigning.x,
    keyAgreementPublicKey: machineAgreement.x,
    fingerprint: "fingerprint_test",
  };

  const device: ClientHello["device"] = {
    id: "device_test",
    name: "iPhone",
    signingPublicKey: deviceSigning.x,
    keyAgreementPublicKey: deviceAgreement.x,
  };

  const principal: RelayAuthPrincipal = {
    kind: "device",
    id: device.id,
    signingPublicKey: device.signingPublicKey,
  };

  const authorizedDevice: HostAuthorizationDevice = {
    id: device.id,
    signingPublicKey: device.signingPublicKey,
    keyAgreementPublicKey: device.keyAgreementPublicKey,
    role: "owner",
  };

  const unsigned: Omit<MachineGrant, "signature"> = {
    version: 1,
    grantId: "grant_test",
    machine: {
      id: machine.id,
      signingPublicKey: machine.signingPublicKey,
      keyAgreementPublicKey: machine.keyAgreementPublicKey,
    },
    device: {
      id: device.id,
      signingPublicKey: device.signingPublicKey,
      keyAgreementPublicKey: device.keyAgreementPublicKey,
    },
    role: "owner",
    issuedAt: "2026-09-18T00:00:00.000Z",
  };

  const grant: MachineGrant = {
    ...unsigned,
    signature: sign(
      null,
      machineGrantMessage(unsigned),
      machineSigning.key.privateKey,
    ).toString("base64url"),
  };

  return {
    machine,
    device,
    principal,
    authorizedDevice,
    grant,
  };
}

function request(machineId = "machine_test"): ControlRequest {
  return {
    protocolVersion: 0,
    type: "control.request",
    requestId: "req_1",
    machineId,
    payload: { op: "sessions.list" },
    authorization: {
      deviceId: "device_test",
      issuedAtMs: 1_800_000_000_000,
      signature: "signature_placeholder",
    },
  };
}

test("routes only when client grant and live host authorization agree", () => {
  const router = new RelayRouter();
  const host = new FakePeer();
  const client = new FakePeer();
  const fx = fixture();

  router.registerHost(host, fx.machine);
  assert.equal(
    router.setHostAuthorizationSnapshot(host, fx.machine.id, [fx.authorizedDevice]),
    true,
  );
  router.registerClient(client, fx.principal, fx.device);
  assert.equal(router.setClientAuthorizations(client, [fx.grant]), true);

  const control = request();
  router.routeClientRequest(client, control);
  assert.deepEqual(JSON.parse(host.sent.at(-1) ?? "{}"), control);

  const response: ControlResponse = {
    protocolVersion: 0,
    type: "control.response",
    requestId: "req_1",
    machineId: fx.machine.id,
    ok: true,
    payload: { op: "sessions.list", sessions: [] },
  };
  router.routeHostResponse(host, response);
  assert.deepEqual(JSON.parse(client.sent.at(-1) ?? "{}"), response);
});

test("rejects control request without a machine grant", () => {
  const router = new RelayRouter();
  const host = new FakePeer();
  const client = new FakePeer();
  const fx = fixture();

  router.registerHost(host, fx.machine);
  router.setHostAuthorizationSnapshot(host, fx.machine.id, [fx.authorizedDevice]);
  router.registerClient(client, fx.principal, fx.device);

  router.routeClientRequest(client, request());

  const response = JSON.parse(client.sent.at(-1) ?? "{}") as ControlResponse;
  assert.equal(response.ok, false);
  assert.equal(response.error?.code, "forbidden");
  assert.equal(host.sent.length, 0);
});

test("host revocation immediately invalidates an otherwise valid grant", () => {
  const router = new RelayRouter();
  const host = new FakePeer();
  const client = new FakePeer();
  const fx = fixture();

  router.registerHost(host, fx.machine);
  router.setHostAuthorizationSnapshot(host, fx.machine.id, [fx.authorizedDevice]);
  router.registerClient(client, fx.principal, fx.device);
  assert.equal(router.setClientAuthorizations(client, [fx.grant]), true);

  router.setHostAuthorizationSnapshot(host, fx.machine.id, []);
  router.routeClientRequest(client, request());

  const response = JSON.parse(client.sent.at(-1) ?? "{}") as ControlResponse;
  assert.equal(response.ok, false);
  assert.equal(response.error?.code, "forbidden");
});

test("same machine id with a different host key cannot intercept traffic", () => {
  const router = new RelayRouter();
  const legitHost = new FakePeer();
  const impostorHost = new FakePeer();
  const client = new FakePeer();
  const fx = fixture();

  const impostorSigning = okpPublicKey("ed25519");
  const impostorAgreement = okpPublicKey("x25519");
  const impostorMachine: MachineDescriptor = {
    ...fx.machine,
    signingPublicKey: impostorSigning.x,
    keyAgreementPublicKey: impostorAgreement.x,
    fingerprint: "fingerprint_impostor",
  };

  router.registerHost(legitHost, fx.machine);
  router.setHostAuthorizationSnapshot(
    legitHost,
    fx.machine.id,
    [fx.authorizedDevice],
  );
  router.registerHost(impostorHost, impostorMachine);
  router.setHostAuthorizationSnapshot(
    impostorHost,
    impostorMachine.id,
    [fx.authorizedDevice],
  );

  router.registerClient(client, fx.principal, fx.device);
  assert.equal(router.setClientAuthorizations(client, [fx.grant]), true);

  const control = request();
  router.routeClientRequest(client, control);

  assert.deepEqual(JSON.parse(legitHost.sent.at(-1) ?? "{}"), control);
  assert.equal(impostorHost.sent.length, 0);
});

test("rejects a grant signed for a different device identity", () => {
  const router = new RelayRouter();
  const client = new FakePeer();
  const fx = fixture();

  const other = fixture();
  const mismatched: MachineGrant = {
    ...fx.grant,
    device: {
      ...fx.grant.device,
      signingPublicKey: other.device.signingPublicKey,
    },
  };

  router.registerClient(client, fx.principal, fx.device);
  assert.equal(router.setClientAuthorizations(client, [mismatched]), false);
});

test("routes opaque Pi RPC frames only between the authorized device and host", () => {
  const router = new RelayRouter();
  const host = new FakePeer();
  const client = new FakePeer();
  const fx = fixture();

  router.registerHost(host, fx.machine);
  router.setHostAuthorizationSnapshot(host, fx.machine.id, [fx.authorizedDevice]);
  router.registerClient(client, fx.principal, fx.device);
  assert.equal(router.setClientAuthorizations(client, [fx.grant]), true);

  const clientFrame: RpcFrame = {
    protocolVersion: 0,
    type: "rpc.frame",
    machineId: fx.machine.id,
    deviceId: fx.device.id,
    channelId: "rpc_test",
    direction: "client",
    seq: 1,
    nonce: "opaque-nonce",
    ciphertext: "opaque-ciphertext",
    tag: "opaque-tag",
  };
  router.routeRpcFrame(client, clientFrame);
  assert.deepEqual(JSON.parse(host.sent.at(-1) ?? "{}"), clientFrame);

  const hostFrame: RpcFrame = {
    ...clientFrame,
    direction: "host",
    seq: 1,
  };
  router.routeRpcFrame(host, hostFrame);
  assert.deepEqual(JSON.parse(client.sent.at(-1) ?? "{}"), hostFrame);
});


test("new connection replaces an older connection for the same device identity", () => {
  const router = new RelayRouter();
  const host = new FakePeer("host");
  const oldClient = new FakePeer("client-old");
  const newClient = new FakePeer("client-new");
  const fx = fixture();

  router.registerHost(host, fx.machine);
  router.setHostAuthorizationSnapshot(
    host,
    fx.machine.id,
    [fx.authorizedDevice],
  );

  router.registerClient(oldClient, fx.principal, fx.device);
  assert.equal(router.setClientAuthorizations(oldClient, [fx.grant]), true);

  router.registerClient(newClient, fx.principal, fx.device);
  assert.deepEqual(oldClient.closed, {
    code: 4001,
    reason: "device connection replaced",
  });
  assert.equal(router.setClientAuthorizations(newClient, [fx.grant]), true);

  const hostFrame: RpcFrame = {
    protocolVersion: 0,
    type: "rpc.frame",
    machineId: fx.machine.id,
    deviceId: fx.device.id,
    channelId: "rpc_test",
    direction: "host",
    seq: 7,
    nonce: "opaque-nonce",
    ciphertext: "opaque-ciphertext",
    tag: "opaque-tag",
  };

  const oldRpcCountBefore = oldClient.sent
    .map(text => JSON.parse(text) as Record<string, unknown>)
    .filter(value => value.type === "rpc.frame")
    .length;

  router.routeRpcFrame(host, hostFrame);

  const oldRpcCountAfter = oldClient.sent
    .map(text => JSON.parse(text) as Record<string, unknown>)
    .filter(value => value.type === "rpc.frame")
    .length;
  const newRpcFrames = newClient.sent
    .map(text => JSON.parse(text) as Record<string, unknown>)
    .filter(value => value.type === "rpc.frame");

  assert.equal(oldRpcCountAfter, oldRpcCountBefore);
  assert.equal(newRpcFrames.length, 1);
  assert.deepEqual(newRpcFrames[0], hostFrame);
});
