import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import {
  createRelayAuthChallenge,
  isRelayAuthResponse,
  type RelayAuthPrincipal,
  verifyRelayAuthResponse,
} from "./auth.js";
import {
  isClientAuthorizations,
  isClientHello,
  isControlRequest,
  isControlResponse,
  isHostAuthorizationSnapshot,
  isHostHello,
  isPairingRequest,
  isPairingResponse,
  isRpcFrame,
  parseJsonObject,
} from "./protocol.js";
import { RelayRouter, type RelayPeer } from "./router.js";

const port = Number(process.env.PORT ?? "8780");
const bindHost = process.env.PI_REMOTE_RELAY_BIND ?? "127.0.0.1";

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be a valid TCP port");
}

const router = new RelayRouter();
const TRACE = process.env.PI_REMOTE_TRACE === "1";

function trace(event: string, fields: Record<string, unknown> = {}): void {
  if (!TRACE) return;
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    component: "relay-server",
    event,
    ...fields,
  }));
}

function peer(ws: WebSocket, id: string): RelayPeer {
  return {
    id,
    send(text) {
      if (ws.readyState === WebSocket.OPEN) ws.send(text);
    },
    close(code, reason) {
      ws.close(code, reason);
    },
  };
}

const server = createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, protocolVersion: 0 }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const role = url.pathname === "/v0/host"
    ? "host"
    : url.pathname === "/v0/client"
      ? "client"
      : null;

  if (!role) {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, ws => {
    const connectionId = "relay_" + randomUUID().replaceAll("-", "").slice(0, 12);
    const relayPeer = peer(ws, connectionId);
    const challenge = createRelayAuthChallenge(role);
    trace("connection.open", {
      connectionId,
      role,
      path: url.pathname,
    });
    let principal: RelayAuthPrincipal | null = null;
    let helloAccepted = false;

    const authTimer = setTimeout(() => {
      if (!principal && ws.readyState === WebSocket.OPEN) {
        ws.close(4003, "authentication timeout");
      }
    }, 31_000);
    authTimer.unref();

    ws.send(JSON.stringify(challenge));

    ws.on("message", raw => {
      const value = parseJsonObject(raw.toString("utf8"));
      if (!value) {
        ws.close(1003, "invalid JSON");
        return;
      }

      if (!principal) {
        if (!isRelayAuthResponse(value)
          || !verifyRelayAuthResponse(challenge, value)) {
          ws.close(4003, "authentication failed");
          return;
        }

        principal = value.principal;
        clearTimeout(authTimer);
        trace("auth.accepted", {
          connectionId,
          role,
          principalKind: principal.kind,
          principalId: principal.id,
        });
        ws.send(JSON.stringify({
          protocolVersion: 0,
          type: "auth.accepted",
          principal,
        }));
        return;
      }

      if (!helloAccepted) {
        if (role === "host"
          && principal.kind === "machine"
          && isHostHello(value)
          && value.machine.id === principal.id
          && value.machine.signingPublicKey === principal.signingPublicKey) {
          helloAccepted = true;
          trace("hello.host", {
            connectionId,
            machineId: value.machine.id,
          });
          router.registerHost(relayPeer, value.machine);
          return;
        }

        if (role === "client"
          && principal.kind === "device"
          && isClientHello(value)
          && value.device.id === principal.id
          && value.device.signingPublicKey === principal.signingPublicKey) {
          helloAccepted = true;
          trace("hello.client", {
            connectionId,
            deviceId: value.device.id,
          });
          router.registerClient(relayPeer, principal, value.device);
          return;
        }

        ws.close(1008, "authenticated hello required");
        return;
      }

      if (role === "host"
        && principal.kind === "machine"
        && isHostAuthorizationSnapshot(value)) {
        if (value.machineId !== principal.id
          || !router.setHostAuthorizationSnapshot(
            relayPeer,
            value.machineId,
            value.devices,
          )) {
          ws.close(1008, "invalid host authorization snapshot");
        }
        return;
      }

      if (role === "client"
        && principal.kind === "device"
        && isClientAuthorizations(value)) {
        if (!router.setClientAuthorizations(relayPeer, value.grants)) {
          ws.close(1008, "invalid client authorizations");
        }
        return;
      }

      if (role === "host" && isPairingResponse(value)) {
        router.routePairingResponse(relayPeer, value);
        return;
      }

      if (role === "client" && isPairingRequest(value)) {
        router.routePairingRequest(relayPeer, value);
        return;
      }

      if (role === "host" && isControlResponse(value)) {
        router.routeHostResponse(relayPeer, value);
        return;
      }

      if (role === "client" && isControlRequest(value)) {
        router.routeClientRequest(relayPeer, value);
        return;
      }

      if (isRpcFrame(value)
        && ((role === "client" && value.direction === "client")
          || (role === "host" && value.direction === "host"))) {
        router.routeRpcFrame(relayPeer, value);
        return;
      }

      ws.close(1008, "unsupported frame");
    });

    ws.on("close", (code, reason) => {
      clearTimeout(authTimer);
      trace("connection.close", {
        connectionId,
        role,
        code,
        reason: reason.toString("utf8"),
      });
      if (role === "host") router.removeHost(relayPeer);
      else router.removeClient(relayPeer);
    });
  });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }
}, 25_000);
heartbeat.unref();

server.listen(port, bindHost, () => {
  console.log(`Pi Remote Relay listening on ${bindHost}:${port}`);
});
