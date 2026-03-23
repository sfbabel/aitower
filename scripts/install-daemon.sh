#!/usr/bin/env bash
# Install and enable the aitower daemon as a systemd user service.
# Auto-detects the repo root and bun path — no hardcoded paths.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
BUN_PATH="$(command -v bun)" || { echo "  ✗ bun not found in PATH"; exit 1; }

UNIT_DIR="$HOME/.config/systemd/user"
UNIT_FILE="$UNIT_DIR/aitower-daemon.service"

mkdir -p "$UNIT_DIR"

cat > "$UNIT_FILE" << EOF
[Unit]
Description=aitower daemon (aitowerd)

[Service]
Type=simple
WorkingDirectory=$REPO_DIR/daemon
ExecStart=$BUN_PATH run src/main.ts
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
EOF

echo "  Wrote $UNIT_FILE"

systemctl --user daemon-reload
echo "  Reloaded systemd user units"

systemctl --user enable --now aitower-daemon
echo "  Enabled and started aitower-daemon"
echo ""

systemctl --user status aitower-daemon --no-pager
