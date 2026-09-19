import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createInterface } from "node:readline";
import { spawn, spawnSync } from "node:child_process";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(scriptDir);
const relayDir = path.join(root, "relay");
const hostDir = path.join(root, "host");
const runtimeDir = path.join(root, ".runtime");
const configHome = path.join(root, ".config");
const toolsDir = path.join(root, ".tools");
const pairSocket = path.join(runtimeDir, "pairing.sock");
const relayLogPath = path.join(runtimeDir, "relay-trace.log");
const hostLogPath = path.join(runtimeDir, "host-trace.log");

const port = Number(process.env.PI_REMOTE_TAILCAT_RELAY_PORT ?? "8791");
const keyName = process.env.PI_REMOTE_TAILCAT_KEY ?? "piremote-test";
const pairTTL = Number(process.env.PI_REMOTE_PAIR_TTL_SECONDS ?? "600");
const trace = process.env.PI_REMOTE_TRACE ?? "1";
const showInitialQr = !process.argv.includes("--no-qr");
const pairUi = (process.env.PI_REMOTE_PAIR_UI ?? "auto")
  .trim()
  .toLowerCase();
const pairQrSize = Number(
  process.env.PI_REMOTE_PAIR_QR_SIZE ?? "240",
);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PI_REMOTE_TAILCAT_RELAY_PORT must be a valid TCP port");
}
if (!Number.isFinite(pairTTL) || pairTTL < 30 || pairTTL > 3600) {
  throw new Error("PI_REMOTE_PAIR_TTL_SECONDS must be between 30 and 3600");
}
if (!["auto", "window", "terminal"].includes(pairUi)) {
  throw new Error(
    "PI_REMOTE_PAIR_UI must be auto, window, or terminal",
  );
}
if (!Number.isFinite(pairQrSize)
    || pairQrSize < 160
    || pairQrSize > 512) {
  throw new Error(
    "PI_REMOTE_PAIR_QR_SIZE must be between 160 and 512 pixels",
  );
}

mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
mkdirSync(configHome, { recursive: true, mode: 0o700 });
mkdirSync(toolsDir, { recursive: true, mode: 0o700 });

const baseEnv = {
  ...process.env,
  XDG_CONFIG_HOME: configHome,
  XDG_RUNTIME_DIR: runtimeDir,
  PI_REMOTE_PAIR_SOCKET: pairSocket,
  PI_REMOTE_TRACE: trace,
};

function commandPath(name) {
  const result = spawnSync("sh", ["-lc", `command -v ${name}`], {
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

function requireCommand(name) {
  const value = commandPath(name);
  if (!value) throw new Error(`${name} is required but was not found in PATH`);
  return value;
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? baseEnv,
    encoding: "utf8",
    stdio: options.quiet ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.status !== 0) {
    const detail = options.quiet
      ? (result.stderr || result.stdout || "").trim()
      : "";
    throw new Error(
      `${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`,
    );
  }
  return result;
}

function findFile(rootDir, filename) {
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    const full = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      const nested = findFile(full, filename);
      if (nested) return nested;
    } else if (entry.isFile() && entry.name === filename) {
      return full;
    }
  }
  return "";
}

async function ensureTailcat() {
  const local = path.join(toolsDir, "tailcat");
  if (existsSync(local)) return local;

  const installed = commandPath("tailcat");
  if (installed) return installed;

  if (process.platform !== "linux") {
    throw new Error(
      "tailcat was not found. Install Tailcat v0.6.0 or place it at .tools/tailcat.",
    );
  }

  const releases = {
    x64: {
      asset: "tailcat_0.6.0_linux_amd64.tar.gz",
      sha256: "f3597a9ad02f5cca538f8f5a6f89123910bce3e9611d1e5a8e96d5f2d3cc90fd",
    },
    arm64: {
      asset: "tailcat_0.6.0_linux_arm64.tar.gz",
      sha256: "fff48f25d223aea31f985bae8a2c01378b22e51e985e8c7d270e1a8586598506",
    },
  };
  const release = releases[process.arch];
  if (!release) {
    throw new Error(
      `automatic Tailcat install does not support ${process.arch}; install v0.6.0 manually`,
    );
  }

  console.log(`[setup] downloading Tailcat v0.6.0 for ${process.arch}...`);
  const url =
    "https://github.com/tailscale/tailcat/releases/download/v0.6.0/"
    + release.asset;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Tailcat download failed: HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== release.sha256) {
    throw new Error("Tailcat download SHA-256 did not match the pinned release");
  }

  const archive = path.join(toolsDir, release.asset);
  const extractDir = path.join(toolsDir, "tailcat-v0.6.0");
  writeFileSync(archive, bytes, { mode: 0o600 });
  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true, mode: 0o700 });
  runChecked(requireCommand("tar"), ["-xzf", archive, "-C", extractDir]);
  rmSync(archive, { force: true });

  const extracted = findFile(extractDir, "tailcat");
  if (!extracted) throw new Error("Tailcat archive did not contain a tailcat binary");
  copyFileSync(extracted, local);
  chmodSync(local, 0o755);
  console.log("[setup] Tailcat v0.6.0 installed locally");
  return local;
}

function ensureNodeDependencies(directory, needsQr = false) {
  const tsx = path.join(directory, "node_modules", ".bin", "tsx");
  const terminalQr = path.join(
    directory,
    "node_modules",
    "qrcode-terminal",
  );
  const svgQr = path.join(
    directory,
    "node_modules",
    "qrcode",
  );
  if (existsSync(tsx)
      && (!needsQr
        || (existsSync(terminalQr) && existsSync(svgQr)))) {
    return;
  }

  console.log(`[setup] installing dependencies in ${path.basename(directory)}...`);
  runChecked(
    requireCommand("npm"),
    ["install", "--no-audit", "--no-fund", "--no-package-lock"],
    { cwd: directory },
  );
}

function ensurePersistentKey(tailcatBin) {
  const keyPath = path.join(
    configHome,
    "tailcat",
    "keys",
    `${keyName}.private.json`,
  );
  if (existsSync(keyPath)) return;

  console.log(`[setup] creating persistent Tailcat key "${keyName}"...`);
  const result = spawnSync(
    tailcatBin,
    ["genkey", `--key=${keyName}`, "--fixed-region"],
    {
      env: baseEnv,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status !== 0) {
    throw new Error(
      "could not create Tailcat key: "
      + (result.stderr || result.stdout || "unknown error").trim(),
    );
  }
  if (!existsSync(keyPath)) {
    throw new Error("Tailcat reported success but the persistent key was not saved");
  }
}

function pipeProcess(child, label, logPath) {
  const stream = createWriteStream(logPath, { flags: "a", mode: 0o600 });
  stream.write(
    `\n=== ${new Date().toISOString()} ${label} start pid=${child.pid} ===\n`,
  );

  const attach = input => {
    if (!input) return;
    const lines = createInterface({ input });
    lines.on("line", line => {
      stream.write(line + "\n");
    });
  };

  attach(child.stdout);
  attach(child.stderr);
  child.once("exit", (code, signal) => {
    stream.write(
      `=== ${new Date().toISOString()} ${label} exit code=${code} signal=${signal} ===\n`,
    );
    stream.end();
  });
}

async function waitFor(description, check, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(
    `timed out waiting for ${description}`
      + (lastError ? `: ${lastError.message}` : ""),
  );
}

function spawnTsx(directory, entry, env) {
  const executable = path.join(directory, "node_modules", ".bin", "tsx");
  return spawn(executable, [entry], {
    cwd: directory,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const tailcatBin = await ensureTailcat();
ensureNodeDependencies(relayDir);
ensureNodeDependencies(hostDir, true);
cleanupPairingQrFiles();
const piCommand = requireCommand("pi");
ensurePersistentKey(tailcatBin);

rmSync(pairSocket, { force: true });

console.log("");
console.log("Pi Remote Tailcat");
console.log("=================");
console.log(`Relay: 127.0.0.1:${port} + [::1]:${port}`);
console.log(`Logs:  ${runtimeDir}`);
console.log("");

let stopping = false;
let qrInFlight = false;
let relay;
let host;
let rawInputEnabled = false;
let lineInput = null;

function clearScreen() {
  if (process.stdout.isTTY) {
    process.stdout.write("\x1b[2J\x1b[H");
  }
}

function printDashboard() {
  console.log("Pi Remote Tailcat");
  console.log("=================");
  console.log("Status: Relay + Host ready");
  console.log(`Relay:  127.0.0.1:${port} + [::1]:${port}`);
  console.log(`Logs:   ${runtimeDir}`);
  console.log("");
}

function cleanupPairingQrFiles() {
  for (const entry of readdirSync(runtimeDir, {
    withFileTypes: true,
  })) {
    if (entry.isFile()
        && entry.name.startsWith("pairing-qr-")
        && entry.name.endsWith(".svg")) {
      rmSync(path.join(runtimeDir, entry.name), {
        force: true,
      });
    }
  }
}

function desktopPairingAvailable() {
  if (process.platform !== "linux") return false;
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return false;
  }
  return Boolean(commandPath("xdg-open"));
}

function shouldUseDesktopPairing() {
  if (pairUi === "terminal") return false;
  if (pairUi === "window") return desktopPairingAvailable();
  return desktopPairingAvailable();
}

async function runPairCli(args, stdout = "ignore") {
  const executable = path.join(
    hostDir,
    "node_modules",
    ".bin",
    "tsx",
  );
  const child = spawn(
    executable,
    ["src/pair-cli.ts", ...args],
    {
      cwd: hostDir,
      env: baseEnv,
      stdio: ["ignore", stdout, "pipe"],
    },
  );

  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", chunk => {
    stderr += chunk;
  });

  const status = await new Promise(resolve => {
    child.once("exit", code => resolve(code ?? 1));
    child.once("error", () => resolve(1));
  });
  return {
    status,
    stderr: stderr.trim(),
  };
}

async function openDesktopQr(svgPath) {
  const opener = commandPath("xdg-open");
  if (!opener) return false;

  return await new Promise(resolve => {
    const child = spawn(opener, [svgPath], {
      detached: true,
      stdio: "ignore",
    });
    let settled = false;
    child.once("error", () => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    });
    child.once("spawn", () => {
      if (!settled) {
        settled = true;
        child.unref();
        resolve(true);
      }
    });
  });
}

function restoreTerminalInput() {
  if (rawInputEnabled && process.stdin.isTTY) {
    process.stdin.setRawMode(false);
    rawInputEnabled = false;
  }
  lineInput?.close();
  lineInput = null;
}

async function shutdown(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  restoreTerminalInput();
  cleanupPairingQrFiles();
  console.log("\n[launcher] stopping Pi Remote Tailcat...");

  for (const child of [host, relay]) {
    if (child && child.exitCode === null) child.kill("SIGTERM");
  }

  await new Promise(resolve => setTimeout(resolve, 800));
  for (const child of [host, relay]) {
    if (child && child.exitCode === null) child.kill("SIGKILL");
  }

  process.exit(exitCode);
}

relay = spawnTsx(relayDir, "src/server.ts", {
  ...baseEnv,
  PORT: String(port),
  PI_REMOTE_RELAY_BIND: "127.0.0.1,::1",
});
pipeProcess(relay, "relay", relayLogPath);

relay.once("exit", (code, signal) => {
  if (!stopping) {
    console.error(`[launcher] Relay exited unexpectedly: code=${code} signal=${signal}`);
    void shutdown(1);
  }
});

await waitFor(
  "Relay health",
  async () => {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    if (!response.ok) return false;
    const body = await response.json();
    return body?.ok === true;
  },
);

host = spawnTsx(hostDir, "src/index.ts", {
  ...baseEnv,
  PI_REMOTE_TRANSPORT: "tailcat",
  PI_REMOTE_TAILCAT_BIN: tailcatBin,
  PI_REMOTE_TAILCAT_KEY: keyName,
  PI_REMOTE_RELAY_URL: `ws://127.0.0.1:${port}/v0/host`,
  PI_REMOTE_PI_COMMAND: piCommand,
});
pipeProcess(host, "host", hostLogPath);

host.once("exit", (code, signal) => {
  if (!stopping) {
    console.error(`[launcher] Host exited unexpectedly: code=${code} signal=${signal}`);
    void shutdown(1);
  }
});

await waitFor(
  "Host pairing socket",
  async () => {
    try {
      return statSync(pairSocket).isSocket();
    } catch {
      return false;
    }
  },
);

async function showPairingQr() {
  if (qrInFlight || stopping) return;
  qrInFlight = true;
  try {
    clearScreen();
    printDashboard();

    if (shouldUseDesktopPairing()) {
      cleanupPairingQrFiles();
      const svgPath = path.join(
        runtimeDir,
        `pairing-qr-${Date.now()}.svg`,
      );
      const result = await runPairCli([
        `--ttl=${pairTTL}`,
        `--qr-svg=${svgPath}`,
        `--qr-size=${Math.round(pairQrSize)}`,
        "--quiet",
      ]);

      if (result.status === 0
          && await openDesktopQr(svgPath)) {
        console.log(
          `Pairing QR opened in your desktop viewer (~${Math.round(pairQrSize)} px).`,
        );
        console.log(
          "Scan it with Pi Remote. The QR file is private and removed on exit.",
        );
        console.log("");
        console.log(
          "Keys: [p] new QR   [q] stop   (no Enter required)",
        );
        return;
      }

      rmSync(svgPath, { force: true });
      if (pairUi === "window") {
        console.log(
          "[launcher] desktop QR could not be opened; using terminal fallback.",
        );
        if (result.stderr) {
          console.log("[launcher] " + result.stderr);
        }
        console.log("");
      }
    }

    const result = await runPairCli(
      [
        `--ttl=${pairTTL}`,
        "--qr",
      ],
      "inherit",
    );
    if (result.status !== 0) {
      console.error(
        "[launcher] could not create pairing QR"
          + (result.stderr ? ": " + result.stderr : ""),
      );
    }
    console.log("");
    console.log(
      "Keys: [p] new QR   [q] stop   (no Enter required)",
    );
  } finally {
    qrInFlight = false;
  }
}

function startControls() {
  if (process.stdin.isTTY
      && typeof process.stdin.setRawMode === "function") {
    process.stdin.setRawMode(true);
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    rawInputEnabled = true;

    process.stdin.on("data", key => {
      if (key === "p" || key === "P") {
        void showPairingQr();
      } else if (
        key === "q"
        || key === "Q"
        || key === "\u0003"
      ) {
        void shutdown(0);
      }
    });
    return;
  }

  lineInput = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });
  lineInput.on("line", line => {
    const command = line.trim().toLowerCase();
    if (command === "p") {
      void showPairingQr();
    } else if (command === "q") {
      void shutdown(0);
    }
  });
}

startControls();

if (showInitialQr) {
  await showPairingQr();
} else {
  clearScreen();
  printDashboard();
  console.log("Keys: [p] pairing QR   [q] stop   (no Enter required)");
}

process.on("exit", () => {
  restoreTerminalInput();
  cleanupPairingQrFiles();
});
process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));
