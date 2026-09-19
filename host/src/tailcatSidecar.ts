import { spawn } from "node:child_process";

export interface TailcatSidecarOptions {
  relayPort: number;
  binary?: string;
  key?: string;
  startupTimeoutMs?: number;
}

const TAILCAT_ADDRESS_PATTERN = /(?:^|\s)(tc[A-Za-z0-9_-]{20,})(?=\s|$)/m;

export function extractTailcatAddress(text: string): string | null {
  return TAILCAT_ADDRESS_PATTERN.exec(text)?.[1] ?? null;
}

export function tailcatServeArgs(
  options: Pick<TailcatSidecarOptions, "relayPort" | "key">,
): string[] {
  if (!Number.isInteger(options.relayPort)
    || options.relayPort < 1
    || options.relayPort > 65_535) {
    throw new Error("Tailcat relayPort must be a valid TCP port");
  }

  const args = ["serve", "--full-address"];
  const key = options.key?.trim();
  if (key) args.push(`--key=${key}`);
  args.push(String(options.relayPort));
  return args;
}

export class TailcatSidecar {
  #child: ReturnType<typeof spawn> | null = null;
  #address: string | null = null;

  constructor(private readonly options: TailcatSidecarOptions) {}

  get address(): string | null {
    return this.#address;
  }

  async start(): Promise<string> {
    if (this.#child) {
      if (this.#address) return this.#address;
      throw new Error("Tailcat sidecar is already starting");
    }

    const binary = this.options.binary?.trim() || "tailcat";
    const child = spawn(binary, tailcatServeArgs(this.options), {
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.#child = child;

    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      let output = "";

      const finish = (address: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.#address = address;
        resolve(address);
      };

      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.#child = null;
        this.#address = null;
        reject(error);
      };

      const consume = (chunk: Buffer | string): void => {
        output = (output + chunk.toString()).slice(-16_384);
        const address = extractTailcatAddress(output);
        if (address) finish(address);
      };

      child.stdout?.on("data", consume);
      child.stderr?.on("data", consume);
      child.once("error", error => {
        fail(new Error(`could not start Tailcat: ${error.message}`));
      });
      child.once("exit", (code, signal) => {
        if (settled) return;
        fail(new Error(
          `Tailcat exited before publishing an address (code=${String(code)}, signal=${String(signal)})`,
        ));
      });

      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        fail(new Error("Tailcat did not publish an address before startup timeout"));
      }, this.options.startupTimeoutMs ?? 15_000);
      timeout.unref();
    });
  }

  async stop(): Promise<void> {
    const child = this.#child;
    this.#child = null;
    this.#address = null;
    if (!child || child.exitCode !== null) return;

    const exited = new Promise<void>(resolve => {
      child.once("exit", () => resolve());
    });

    child.kill("SIGTERM");
    const forceTimer = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 2_000);
    forceTimer.unref();

    await exited;
    clearTimeout(forceTimer);
  }
}
