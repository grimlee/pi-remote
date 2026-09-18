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
  parseJsonObject,
} from "./protocol.js";
import { RelayRouter, type RelayPeer } from "./router.js";

const port = Number(process.env.PORT ?? "8780");

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be a valid TCP port");
}

const router = new RelayRouter();

function peer(ws: WebSocket): RelayPeer {
  return {
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
    const relayPeer = peer(ws);
    const challenge = createRelayAuthChallenge(role);
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
          router.registerHost(relayPeer, value.machine);
          return;
        }

        if (role === "client"
          && principal.kind === "device"
          && isClientHello(value)
          && value.device.id === principal.id
          && value.device.signingPublicKey === principal.signingPublicKey) {
          helloAccepted = true;
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

      if (role === "host" && isControlResponse(value)) {
        router.routeHostResponse(relayPeer, value);
        return;
      }

      if (role === "client" && isControlRequest(value)) {
        router.routeClientRequest(relayPeer, value);
        return;
      }

      ws.close(1008, "unsupported frame");
    });

    ws.on("close", () => {
      clearTimeout(authTimer);
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

server.listen(port, "0.0.0.0", () => {
  console.log(`Pi Remote Relay listening on :${port}`);
});
