import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  isClientHello,
  isControlRequest,
  isControlResponse,
  isHostHello,
  parseJsonObject,
} from "./protocol.js";
import { RelayRouter, type RelayPeer } from "./router.js";

const port = Number(process.env.PORT ?? "8780");
const bootstrapToken = process.env.PI_REMOTE_RELAY_TOKEN;

if (!bootstrapToken) {
  throw new Error("PI_REMOTE_RELAY_TOKEN is required for the development relay");
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be a valid TCP port");
}

const router = new RelayRouter();

function peer(ws: WebSocket): RelayPeer {
  return {
    send(text) {
      if (ws.readyState === ws.OPEN) ws.send(text);
    },
    close(code, reason) {
      ws.close(code, reason);
    },
  };
}

function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length);
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

  if (!role || bearerToken(req.headers.authorization) !== bootstrapToken) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, ws => {
    const relayPeer = peer(ws);
    let helloAccepted = false;

    ws.on("message", raw => {
      const value = parseJsonObject(raw.toString("utf8"));
      if (!value) {
        ws.close(1003, "invalid JSON");
        return;
      }

      if (!helloAccepted) {
        if (role === "host" && isHostHello(value)) {
          helloAccepted = true;
          router.registerHost(relayPeer, value.machine);
          return;
        }
        if (role === "client" && isClientHello(value)) {
          helloAccepted = true;
          router.registerClient(relayPeer);
          return;
        }
        ws.close(1008, "hello required");
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
      if (role === "host") router.removeHost(relayPeer);
      else router.removeClient(relayPeer);
    });
  });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) ws.ping();
  }
}, 25_000);
heartbeat.unref();

server.listen(port, "0.0.0.0", () => {
  console.log(`Pi Remote Relay listening on :${port}`);
});
