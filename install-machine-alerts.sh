#!/usr/bin/env sh
set -eu

SERVER="${ASENIX_WATCHER_SERVER:-}"
TOKEN="${ASENIX_WATCHER_TOKEN:-}"
INSTALL_DIR="${ASENIX_WATCHER_DIR:-$HOME/.asenix-watcher}"
REPO_URL="${ASENIX_WATCHER_REPO:-https://github.com/sacura1/asenix-watcher.git}"

if [ -z "$SERVER" ] || [ -z "$TOKEN" ]; then
  echo "ASENIX_WATCHER_SERVER and ASENIX_WATCHER_TOKEN are required." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20+ is required before enabling Machine alerts." >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR"

if [ ! -d "$INSTALL_DIR/.git" ]; then
  if ! command -v git >/dev/null 2>&1; then
    echo "git is required for this installer." >&2
    exit 1
  fi
  git clone "$REPO_URL" "$INSTALL_DIR"
else
  git -C "$INSTALL_DIR" pull --ff-only
fi

cat > "$INSTALL_DIR/.env" <<EOF
ASENIX_WATCHER_SERVER=$SERVER
ASENIX_WATCHER_TOKEN=$TOKEN
ASENIX_NODE_RPC_URL=${ASENIX_NODE_RPC_URL:-http://127.0.0.1:8545}
ASENIX_NODE_PROCESS_NAMES=${ASENIX_NODE_PROCESS_NAMES:-asentum-validator}
ASENIX_SYSTEMD_SERVICES=${ASENIX_SYSTEMD_SERVICES:-asentum-validator}
ASENIX_DISK_PATHS=${ASENIX_DISK_PATHS:-/}
EOF

if command -v systemctl >/dev/null 2>&1; then
  SERVICE_PATH="$HOME/.config/systemd/user"
  mkdir -p "$SERVICE_PATH"
  cat > "$SERVICE_PATH/asenix-watcher.service" <<EOF
[Unit]
Description=Asenix Watcher Machine alerts
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$INSTALL_DIR/.env
ExecStart=$(command -v node) $INSTALL_DIR/src/agent.mjs
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
EOF
  if systemctl --user daemon-reload && systemctl --user enable --now asenix-watcher.service; then
    echo "Machine alerts installed and started with systemd user service."
  else
    nohup node "$INSTALL_DIR/src/agent.mjs" > "$INSTALL_DIR/asenix-watcher.log" 2>&1 &
    echo "Machine alerts installed and started in the background."
    echo "Log file: $INSTALL_DIR/asenix-watcher.log"
  fi
else
  nohup node "$INSTALL_DIR/src/agent.mjs" > "$INSTALL_DIR/asenix-watcher.log" 2>&1 &
  echo "Machine alerts installed and started in the background."
  echo "Log file: $INSTALL_DIR/asenix-watcher.log"
fi
