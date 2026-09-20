import { spawn } from "node:child_process";

export interface TailcatSidecarOptions {
  relayPort: number;
  binary?: string;
  key?: string;
  startupTimeoutMs?: number;
  verbose?: boolean;
}

const TAILCAT_ADDRESS_PATTERN = /(?:^|\s)(tc[A-Za-z0-9_-]{20,})(?=\s|$)/m;
const TAILCAT_SECRET_PATTERN = /tc[A-Za-z0-9_-]{20,}/g;

export function extractTailcatAddress(text: string): string | null {
  return TAILCAT_ADDRESS_PATTERN.exec(text)?.[1] ?? null;
}

export function redactTailcatSecrets(text: string): string {
  return text.replace(TAILCAT_SECRET_PATTERN, "tc[REDACTED]");
}

export function tailcatServeArgs(
  options: Pick<TailcatSidecarOptions, "relayPort" | "key" | "verbose">,
): string[] {
  if (!Number.isInteger(options.relayPort)
    || options.relayPort < 1
    || options.relayPort > 65_535) {
    throw new Error("Tailcat relayPort must be a valid TCP port");
  }

  const args: string[] = [];
  if (options.verbose) args.push("--verbose");
  args.push("serve", "--full-address");
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
      const logBuffers = {
        stdout: "",
        stderr: "",
      };

      const logChunk = (
        source: "stdout" | "stderr",
        text: string,
      ): void => {
        if (!this.options.verbose) return;
        logBuffers[source] += text;

        while (true) {
          const index = logBuffers[source].indexOf("\n");
          if (index < 0) break;

          let line = logBuffers[source].slice(0, index);
          logBuffers[source] = logBuffers[source].slice(index + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (!line.trim()) continue;

          console.log(
            JSON.stringify({
              ts: new Date().toISOString(),
              component: "tailcat-sidecar",
              stream: source,
              message: redactTailcatSecrets(line),
            }),
          );
        }
      };

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

      const consume = (
        source: "stdout" | "stderr",
        chunk: Buffer | string,
      ): void => {
        const text = chunk.toString();
        output = (output + text).slice(-16_384);
        logChunk(source, text);
        const address = extractTailcatAddress(output);
        if (address) finish(address);
      };

      child.stdout?.on("data", chunk => consume("stdout", chunk));
      child.stderr?.on("data", chunk => consume("stderr", chunk));
      child.once("error", error => {
        fail(new Error(`could not start Tailcat: ${error.message}`));
      });
      child.once("exit", (code, signal) => {
        if (this.options.verbose) {
          for (const source of ["stdout", "stderr"] as const) {
            const tail = logBuffers[source].trim();
            if (!tail) continue;
            console.log(
              JSON.stringify({
                ts: new Date().toISOString(),
                component: "tailcat-sidecar",
                stream: source,
                message: redactTailcatSecrets(tail),
              }),
            );
          }
        }

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
