#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
CONFIG_DIR="$CONFIG_HOME/pi-remote"

SYSTEMCTL="$(command -v systemctl || true)"
NODE="$(command -v node || true)"

[ -n "$SYSTEMCTL" ] || { echo "FAIL systemctl not found" >&2; exit 1; }
[ -n "$NODE" ] || { echo "FAIL node not found" >&2; exit 1; }
[ -f "$CONFIG_DIR/relay.env" ] || { echo "FAIL $CONFIG_DIR/relay.env missing" >&2; exit 1; }
[ -f "$CONFIG_DIR/host.env" ] || { echo "FAIL $CONFIG_DIR/host.env missing" >&2; exit 1; }

set -a
. "$CONFIG_DIR/relay.env"
. "$CONFIG_DIR/host.env"
set +a

PORT="${PORT:-8780}"
OMP_COMMAND="${PI_REMOTE_OMP_COMMAND:-omp}"

echo "Checking services..."
"$SYSTEMCTL" --user --quiet is-active pi-remote-relay.service
echo "PASS pi-remote-relay.service active"
"$SYSTEMCTL" --user --quiet is-active pi-remote-host.service
echo "PASS pi-remote-host.service active"

echo "Checking local Relay health..."
"$NODE" -e '
const url=process.argv[1];
fetch(url)
  .then(async r => {
    if (!r.ok) throw new Error("HTTP " + r.status);
    const body=await r.json();
    if (body.ok !== true || body.protocolVersion !== 0) throw new Error("unexpected body");
  })
  .catch(error => {
    console.error(error.message);
    process.exit(1);
  });
' "http://127.0.0.1:$PORT/healthz"
echo "PASS Relay healthz"

echo "Checking OMP Collab registry..."
if [ ! -x "$OMP_COMMAND" ]; then
  echo "FAIL OMP executable is not executable: $OMP_COMMAND" >&2
  exit 1
fi

COLLAB_JSON="$("$OMP_COMMAND" collab list --json)"
printf '%s' "$COLLAB_JSON" | "$NODE" -e '
let body="";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => body += chunk);
process.stdin.on("end", () => {
  const value=JSON.parse(body);
  if (!Array.isArray(value.hosts)) {
    console.error("OMP response has no hosts[]");
    process.exit(1);
  }
  console.log("PASS OMP Collab registry readable; active hosts:", value.hosts.length);
  for (const host of value.hosts) {
    console.log("  -", host.instanceId, "generation", host.generation, host.sessionName ?? host.cwd);
  }
});
'

if [ -n "${PI_REMOTE_PAIR_SOCKET:-}" ]; then
  PAIR_SOCKET="$PI_REMOTE_PAIR_SOCKET"
elif [ -n "${XDG_RUNTIME_DIR:-}" ]; then
  PAIR_SOCKET="$XDG_RUNTIME_DIR/pi-remote/pairing.sock"
else
  PAIR_SOCKET="$HOME/.config/pi-remote/run/pairing.sock"
fi

if [ -S "$PAIR_SOCKET" ]; then
  echo "PASS pairing IPC socket: $PAIR_SOCKET"
else
  echo "FAIL pairing IPC socket missing: $PAIR_SOCKET" >&2
  exit 1
fi

echo ""
echo "Configured outbound Relay URL:"
echo "  ${PI_REMOTE_RELAY_URL:-<missing>}"
echo ""
echo "Preflight complete."
echo "Create pairing payload with:"
echo "  npm --prefix \"$ROOT/host\" run pair"
