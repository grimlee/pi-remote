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

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new PiRegistryError("invalid_response", `Pi returned an invalid ${field}`);
  }
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return requiredString(value, field);
}

function requiredInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new PiRegistryError("invalid_response", `Pi returned an invalid ${field}`);
  }
  return value;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new PiRegistryError("invalid_response", `Pi returned an invalid ${field}`);
  }
  return value;
}

function parseAccess(value: unknown): SessionAccess {
  if (value === "view" || value === "control") return value;
  throw new PiRegistryError("invalid_response", "Pi returned an unknown Collab access level");
}

function parseModel(value: unknown): string | null {
  if (value === null) return null;
  const model = asRecord(value);
  const provider = requiredString(model.provider, "model.provider");
  const id = requiredString(model.id, "model.id");
  return `${provider}/${id}`;
}

function toIsoTime(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new PiRegistryError("invalid_response", "Pi returned an invalid startedAt");
  }
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    throw new PiRegistryError("invalid_response", "Pi returned an invalid startedAt");
  }
  return date.toISOString();
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
    const generation = requiredInteger(host.generation, "generation");
    if (generation < 1) {
      throw new PiRegistryError("invalid_response", "Pi returned an invalid generation");
    }

    const participants = requiredInteger(host.participants, "participants");
    if (participants < 0) {
      throw new PiRegistryError("invalid_response", "Pi returned an invalid participant count");
    }

    return {
      instanceId: requiredString(host.instanceId, "instanceId"),
      generation,
      sessionId: requiredString(host.sessionId, "sessionId"),
      name: nullableString(host.sessionName, "sessionName"),
      cwd: requiredString(host.cwd, "cwd"),
      model: parseModel(host.model),
      startedAt: toIsoTime(host.startedAt),
      participantCount: participants,
      relayConnected: requiredBoolean(host.relayConnected, "relayConnected"),
      inputRequired: requiredBoolean(host.inputRequired, "inputRequired"),
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
  const generation = requiredInteger(root.generation, "generation");
  if (generation < 1) {
    throw new PiRegistryError("invalid_response", "Pi returned an invalid generation");
  }

  const collabUrl = typeof root.url === "string"
    ? root.url
    : typeof root.collabUrl === "string"
      ? root.collabUrl
      : null;

  if (!collabUrl) {
    throw new PiRegistryError("invalid_response", "Pi returned an incomplete Collab link response");
  }

  return {
    instanceId: requiredString(root.instanceId, "instanceId"),
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
    if (!Number.isInteger(generation) || generation < 1) {
      throw new TypeError("generation must be a positive integer");
    }

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
