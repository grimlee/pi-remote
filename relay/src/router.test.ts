import assert from "node:assert/strict";
import test from "node:test";
import type { RelayPeer } from "./router.js";
import { RelayRouter } from "./router.js";
import type { ControlRequest, ControlResponse } from "./protocol.js";

class FakePeer implements RelayPeer {
  readonly sent: string[] = [];
  closed: { code: number | undefined; reason: string | undefined } | null = null;

  send(text: string): void {
    this.sent.push(text);
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
}

test("routes a control request host -> client round trip", () => {
  const router = new RelayRouter();
  const host = new FakePeer();
  const client = new FakePeer();

  router.registerHost(host, {
    id: "machine_test",
    name: "omarchy",
    platform: "linux",
    capabilities: ["sessions.list"],
  });
  router.registerClient(client);

  const request: ControlRequest = {
    protocolVersion: 0,
    type: "control.request",
    requestId: "req_1",
    machineId: "machine_test",
    payload: { op: "sessions.list" },
  };

  router.routeClientRequest(client, request);
  assert.deepEqual(JSON.parse(host.sent.at(-1) ?? "{}"), request);

  const response: ControlResponse = {
    protocolVersion: 0,
    type: "control.response",
    requestId: "req_1",
    machineId: "machine_test",
    ok: true,
    payload: { op: "sessions.list", sessions: [] },
  };

  router.routeHostResponse(host, response);
  assert.deepEqual(JSON.parse(client.sent.at(-1) ?? "{}"), response);
});

test("returns machine_offline when target host is absent", () => {
  const router = new RelayRouter();
  const client = new FakePeer();
  router.registerClient(client);

  router.routeClientRequest(client, {
    protocolVersion: 0,
    type: "control.request",
    requestId: "req_offline",
    machineId: "missing",
    payload: { op: "sessions.list" },
  });

  const response = JSON.parse(client.sent.at(-1) ?? "{}") as ControlResponse;
  assert.equal(response.ok, false);
  assert.equal(response.error?.code, "machine_offline");
});
