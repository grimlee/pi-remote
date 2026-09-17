import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CommandRunner, RemoteSession, SessionAccess, SessionLink } from "./types.js";

const execFileAsync = promisify(execFile);

export class PiRegistryError extends Error {
  constructor(
    readonly code:
      | "invalid_response"
      | "pi_command_failed"
      | "stale_generation"
      | "unsupported_access",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PiRegistryError";
  }
}

export class NodeCommandRunner implements CommandRunner {
  constructor(private readonly executable = "omp") {}

  async run(_command: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
    try {
      const result = await execFileAsync(this.executable, [...args], {
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      });
      return { stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      throw new PiRegistryError("pi_command_failed", "Pi command failed", { cause: error });
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PiRegistryError("invalid_response", "Expected a JSON object from Pi");
  }
  return value as Record<string, unknown>;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function booleanOrFalse(value: unknown): boolean {
  return value === true;
}

function integerOr(value: unknown, fallback: number): number {
  return Number.isInteger(value) && typeof value === "number" ? value : fallback;
}

function parseAccess(value: unknown): SessionAccess {
  if (value === "view" || value === "control") return value;
  throw new PiRegistryError("invalid_response", "Pi returned an unknown Collab access level");
}

export function parseSessionList(json: string): RemoteSession[] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(json);
  } catch (error) {
    throw new PiRegistryError("invalid_response", "Pi returned invalid JSON", { cause: error });
  }

  const root = asRecord(decoded);
  const hosts = root.hosts;
  if (!Array.isArray(hosts)) {
    throw new PiRegistryError("invalid_response", "Pi Collab list response did not contain hosts[]");
  }

  return hosts.map((hostValue) => {
    const host = asRecord(hostValue);
    const instanceId = stringOrNull(host.instanceId);
    const generation = integerOr(host.generation, -1);
    if (!instanceId || generation < 0) {
      throw new PiRegistryError("invalid_response", "Pi returned a host without a valid instanceId/generation");
    }

    return {
      instanceId,
      generation,
      sessionId: stringOrNull(host.sessionId),
      name: stringOrNull(host.sessionName ?? host.name),
      cwd: stringOrNull(host.cwd),
      model: stringOrNull(host.model),
      startedAt: stringOrNull(host.startedAt ?? host.createdAt),
      participantCount: Math.max(0, integerOr(host.participantCount, 0)),
      relayConnected: booleanOrFalse(host.connected ?? host.relayConnected),
      inputRequired: booleanOrFalse(host.inputRequired),
      access: parseAccess(host.access),
    };
  });
}

export function parseSessionLink(json: string): SessionLink {
  let decoded: unknown;
  try {
    decoded = JSON.parse(json);
  } catch (error) {
    throw new PiRegistryError("invalid_response", "Pi returned invalid JSON", { cause: error });
  }

  const root = asRecord(decoded);
  const instanceId = stringOrNull(root.instanceId);
  const generation = integerOr(root.generation, -1);
  const collabUrl = stringOrNull(root.url ?? root.collabUrl);

  if (!instanceId || generation < 0 || !collabUrl) {
    throw new PiRegistryError("invalid_response", "Pi returned an incomplete Collab link response");
  }

  return {
    instanceId,
    generation,
    access: parseAccess(root.access),
    collabUrl,
  };
}

export class PiRegistry {
  constructor(private readonly runner: CommandRunner = new NodeCommandRunner()) {}

  async listSessions(): Promise<RemoteSession[]> {
    const { stdout } = await this.runner.run("omp", ["collab", "list", "--json"]);
    return parseSessionList(stdout);
  }

  async createLink(instanceId: string, generation: number, access: SessionAccess): Promise<SessionLink> {
    if (!instanceId) throw new TypeError("instanceId is required");
    if (!Number.isInteger(generation) || generation < 0) throw new TypeError("generation must be a non-negative integer");

    const args = ["collab", "link", instanceId, "--json"];
    if (access === "view") args.push("--view");

    const { stdout } = await this.runner.run("omp", args);
    const link = parseSessionLink(stdout);

    if (link.generation !== generation) {
      throw new PiRegistryError(
        "stale_generation",
        "The selected Pi session changed before a control link could be issued",
      );
    }
    if (link.access !== access) {
      throw new PiRegistryError("unsupported_access", "Pi did not issue the requested Collab access level");
    }

    return link;
  }
}
