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
PI_COMMAND="${PI_REMOTE_PI_COMMAND:-pi}"

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

echo "Checking Pi RPC support..."
if [ ! -x "$PI_COMMAND" ]; then
  echo "FAIL Pi executable is not executable: $PI_COMMAND" >&2
  exit 1
fi

PI_VERSION="$("$PI_COMMAND" --version 2>/dev/null || true)"
if [ -z "$PI_VERSION" ]; then
  echo "FAIL Pi --version returned no output" >&2
  exit 1
fi
if ! "$PI_COMMAND" --help 2>&1 | grep -q -- "--mode <mode>"; then
  echo "FAIL Pi does not advertise --mode rpc support" >&2
  exit 1
fi
echo "PASS Pi RPC executable: $PI_COMMAND ($PI_VERSION)"

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
