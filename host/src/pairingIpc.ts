import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { PairingService } from "./pairing.js";
import {
  encodePairingBootstrap,
  relayClientUrl,
  type PairingBootstrap,
} from "./pairingBootstrap.js";

function runtimeRoot(): string {
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg && xdg.length > 0) {
    return path.join(xdg, "pi-remote");
  }
  return path.join(os.homedir(), ".config", "pi-remote", "run");
}

export function defaultPairingSocketPath(): string {
  return process.env.PI_REMOTE_PAIR_SOCKET
    ?? path.join(runtimeRoot(), "pairing.sock");
}

interface PairCreateRequest {
  op: "pair.create";
  ttlMs?: number;
}

function parseRequest(line: string): PairCreateRequest {
  const value: unknown = JSON.parse(line);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid pairing IPC request");
  }
  const record = value as Record<string, unknown>;
  if (record.op !== "pair.create") {
    throw new Error("unsupported pairing IPC operation");
  }
  if (record.ttlMs !== undefined
    && (typeof record.ttlMs !== "number" || !Number.isFinite(record.ttlMs))) {
    throw new Error("invalid pairing ttl");
  }
  return {
    op: "pair.create",
    ...(typeof record.ttlMs === "number" ? { ttlMs: record.ttlMs } : {}),
  };
}

export class PairingIpcServer {
  #server: net.Server | null = null;

  constructor(
    private readonly pairing: PairingService,
    private readonly relayHostUrl: string,
    private readonly socketPath = defaultPairingSocketPath(),
  ) {}

  async start(): Promise<void> {
    if (this.#server) return;

    await fs.mkdir(path.dirname(this.socketPath), {
      recursive: true,
      mode: 0o700,
    });
    await fs.rm(this.socketPath, { force: true });

    const server = net.createServer(socket => {
      socket.setEncoding("utf8");
      let buffer = "";

      socket.on("data", chunk => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;

        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);

        void this.#handle(line)
          .then(response => {
            socket.end(JSON.stringify({ ok: true, ...response }) + "\n");
          })
          .catch(error => {
            socket.end(JSON.stringify({
              ok: false,
              error: error instanceof Error ? error.message : "pairing IPC failed",
            }) + "\n");
          });
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });

    await fs.chmod(this.socketPath, 0o600);
    this.#server = server;
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    if (!server) return;

    await new Promise<void>(resolve => {
      server.close(() => resolve());
    });
    await fs.rm(this.socketPath, { force: true });
  }

  async #handle(line: string): Promise<{
    bootstrap: string;
    expiresAt: string;
    machineName: string;
  }> {
    const request = parseRequest(line);
    const invitation = this.pairing.createInvitation(request.ttlMs);
    const bootstrap: PairingBootstrap = {
      version: 1,
      relayUrl: relayClientUrl(this.relayHostUrl),
      invitation,
    };

    return {
      bootstrap: encodePairingBootstrap(bootstrap),
      expiresAt: invitation.expiresAt,
      machineName: invitation.machine.name,
    };
  }
}
