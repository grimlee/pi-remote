import { loadOrCreateMachineIdentity } from "./machineIdentity.js";
import { RelayHostClient } from "./relayClient.js";

const relayUrl = process.env.PI_REMOTE_RELAY_URL ?? "ws://127.0.0.1:8780/v0/host";
const token = process.env.PI_REMOTE_RELAY_TOKEN;

if (!token) {
  throw new Error("PI_REMOTE_RELAY_TOKEN is required while development bootstrap authentication is in use");
}

const machine = await loadOrCreateMachineIdentity();
const client = new RelayHostClient({
  url: relayUrl,
  token,
  machine,
});

client.start();

function shutdown(): void {
  client.stop();
  setTimeout(() => process.exit(0), 50).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
