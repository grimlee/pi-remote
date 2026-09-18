#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./scripts/install-user-services.sh --relay-url wss://relay.example.com/v0/host [options]

Options:
  --relay-url URL   Public Pi Remote Relay host WebSocket URL. Required.
  --omp PATH        OMP executable path. Defaults to command -v omp.
  --port PORT       Local Relay listen port. Defaults to 8780.
  --no-enable       Install/build units without enabling or starting them.
  -h, --help        Show this help.
EOF
}

RELAY_URL=""
OMP_COMMAND=""
PORT="8780"
ENABLE="1"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --relay-url)
      [ "$#" -ge 2 ] || { echo "missing value for --relay-url" >&2; exit 2; }
      RELAY_URL="$2"
      shift 2
      ;;
    --omp)
      [ "$#" -ge 2 ] || { echo "missing value for --omp" >&2; exit 2; }
      OMP_COMMAND="$2"
      shift 2
      ;;
    --port)
      [ "$#" -ge 2 ] || { echo "missing value for --port" >&2; exit 2; }
      PORT="$2"
      shift 2
      ;;
    --no-enable)
      ENABLE="0"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ -z "$RELAY_URL" ]; then
  echo "--relay-url is required" >&2
  usage >&2
  exit 2
fi

case "$RELAY_URL" in
  wss://*/v0/host) ;;
  *)
    echo "--relay-url must be a wss:// URL ending in /v0/host" >&2
    exit 2
    ;;
esac

case "$PORT" in
  ''|*[!0-9]*)
    echo "--port must be an integer" >&2
    exit 2
    ;;
esac

if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  echo "--port must be between 1 and 65535" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

NODE="$(command -v node || true)"
NPM="$(command -v npm || true)"
SYSTEMCTL="$(command -v systemctl || true)"

[ -n "$NODE" ] || { echo "node is required" >&2; exit 1; }
[ -n "$NPM" ] || { echo "npm is required" >&2; exit 1; }
[ -n "$SYSTEMCTL" ] || { echo "systemctl is required" >&2; exit 1; }

NODE_MAJOR="$("$NODE" -p 'Number(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Node 22 or newer is required; found $("$NODE" --version)" >&2
  exit 1
fi

if [ -z "$OMP_COMMAND" ]; then
  OMP_COMMAND="$(command -v omp || true)"
fi
if [ -z "$OMP_COMMAND" ] || [ ! -x "$OMP_COMMAND" ]; then
  echo "OMP executable not found. Pass --omp /absolute/path/to/omp." >&2
  exit 1
fi

CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
CONFIG_DIR="$CONFIG_HOME/pi-remote"
SYSTEMD_DIR="$CONFIG_HOME/systemd/user"

mkdir -p "$CONFIG_DIR" "$SYSTEMD_DIR"
chmod 700 "$CONFIG_DIR"

echo "Installing Node dependencies..."
"$NPM" --prefix "$ROOT/relay" install --no-audit --no-fund
"$NPM" --prefix "$ROOT/host" install --no-audit --no-fund

echo "Building Relay and Host..."
"$NPM" --prefix "$ROOT/relay" run build
"$NPM" --prefix "$ROOT/host" run build

cat > "$CONFIG_DIR/relay.env" <<EOF
PORT=$PORT
PI_REMOTE_RELAY_BIND=127.0.0.1
EOF

cat > "$CONFIG_DIR/host.env" <<EOF
PI_REMOTE_RELAY_URL=$RELAY_URL
PI_REMOTE_OMP_COMMAND=$OMP_COMMAND
EOF

chmod 600 "$CONFIG_DIR/relay.env" "$CONFIG_DIR/host.env"

cat > "$SYSTEMD_DIR/pi-remote-relay.service" <<EOF
[Unit]
Description=Pi Remote Relay
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT/relay
Environment=NODE_ENV=production
EnvironmentFile=$CONFIG_DIR/relay.env
ExecStart=$NODE $ROOT/relay/dist/server.js
Restart=on-failure
RestartSec=2
UMask=0077
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
EOF

cat > "$SYSTEMD_DIR/pi-remote-host.service" <<EOF
[Unit]
Description=Pi Remote Host
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT/host
Environment=NODE_ENV=production
EnvironmentFile=$CONFIG_DIR/host.env
ExecStart=$NODE $ROOT/host/dist/index.js
Restart=on-failure
RestartSec=2
UMask=0077
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
EOF

"$SYSTEMCTL" --user daemon-reload

if [ "$ENABLE" = "1" ]; then
  "$SYSTEMCTL" --user enable --now pi-remote-relay.service
  "$SYSTEMCTL" --user enable --now pi-remote-host.service

  echo "Checking local Relay health..."
  HEALTH_URL="http://127.0.0.1:$PORT/healthz"
  HEALTH_OK="0"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if "$NODE" -e "fetch(process.argv[1]).then(r=>{if(!r.ok)process.exit(1);return r.json()}).then(v=>{if(v.ok!==true)process.exit(1)}).catch(()=>process.exit(1))" "$HEALTH_URL"; then
      HEALTH_OK="1"
      break
    fi
    sleep 0.5
  done

  if [ "$HEALTH_OK" != "1" ]; then
    echo "Relay health check failed: $HEALTH_URL" >&2
    "$SYSTEMCTL" --user --no-pager status pi-remote-relay.service || true
    exit 1
  fi

  "$SYSTEMCTL" --user --quiet is-active pi-remote-relay.service
  "$SYSTEMCTL" --user --quiet is-active pi-remote-host.service
fi

cat <<EOF

Pi Remote user services installed.

Repository:
  $ROOT

Relay local origin:
  http://127.0.0.1:$PORT

Host outbound Relay URL:
  $RELAY_URL

OMP executable:
  $OMP_COMMAND

Next:
  1. Point your public tunnel hostname at http://127.0.0.1:$PORT
  2. Verify: bash $SCRIPT_DIR/preflight-real-device.sh
  3. Create a one-time pairing payload:
       $NPM --prefix "$ROOT/host" run pair

Logs:
  journalctl --user -u pi-remote-relay.service -f
  journalctl --user -u pi-remote-host.service -f
EOF
