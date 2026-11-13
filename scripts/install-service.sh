#!/usr/bin/env bash
# Installs ManifestHound as a systemd service (Debian/Ubuntu, x64 or arm64). Run as root: sudo ./scripts/install-service.sh [run-as-user]
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo." >&2; exit 1; }
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN_USER="${1:-${SUDO_USER:-root}}"
# Needs Node 24+ (node:sqlite). A system node is often older, so also look in the run user's nvm folder.
HOME_DIR="$(getent passwd "$RUN_USER" | cut -d: -f6)"
NODE=""
for cand in "$(command -v node || true)" $(ls -d "$HOME_DIR"/.nvm/versions/node/v*/bin/node 2>/dev/null | sort -V -r); do
  [ -x "$cand" ] || continue
  [ "$("$cand" -p 'process.versions.node.split(".")[0]')" -ge 24 ] && { NODE="$cand"; break; }
done
[ -n "$NODE" ] || { echo "Node.js 24+ not found (system node is too old for node:sqlite). Install it, e.g. with nvm." >&2; exit 1; }
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
