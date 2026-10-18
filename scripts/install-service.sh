#!/usr/bin/env bash
# Installs ManifestHound as a systemd service (Debian/Ubuntu, x64 or arm64). Run as root: sudo ./scripts/install-service.sh [run-as-user]
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo." >&2; exit 1; }
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN_USER="${1:-${SUDO_USER:-root}}"
NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "node not found (need Node.js 24+)." >&2; exit 1; }
[ -f "$ROOT/dist/main.js" ] || { echo "Run 'npm run build' first." >&2; exit 1; }
cat > /etc/systemd/system/manifesthound.service <<UNIT
[Unit]
Description=ManifestHound Steam update watcher
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$ROOT
ExecStart=$NODE dist/main.js
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=30
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now manifesthound
echo "Installed. Logs: journalctl -u manifesthound -f   Dashboard: http://127.0.0.1:4019"
echo "First-run admin password: $ROOT/data/initial-admin-password.txt"
