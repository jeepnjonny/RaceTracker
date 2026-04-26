#!/usr/bin/env bash
# RaceTracker — first-time server setup
# Run as a user with sudo access on apps.k7swi.org
# Usage: bash setup.sh [--ssl]

set -euo pipefail

INSTALL_DIR="/srv/RaceTracker"
SERVICE_USER="www-data"
NODE_MIN="18"
HOSTNAME="apps.k7swi.org"
SSL=${1:-""}

echo "=== RaceTracker Setup ==="

# ── Node.js ────────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo "Node.js not found. Installing via NodeSource (v20)..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

NODE_VER=$(node -e "process.stdout.write(process.versions.node.split('.')[0])")
if [ "$NODE_VER" -lt "$NODE_MIN" ]; then
  echo "Node.js >= ${NODE_MIN} required (found ${NODE_VER}). Aborting."
  exit 1
fi
echo "  Node.js $(node --version) OK"

# ── Deploy files ───────────────────────────────────────────────────────────
sudo mkdir -p "${INSTALL_DIR}"
sudo rsync -av --delete \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='data' \
  "$(dirname "$(realpath "$0")")/" "${INSTALL_DIR}/"

sudo mkdir -p "${INSTALL_DIR}/data/uploads/tracks" \
             "${INSTALL_DIR}/data/uploads/participants"
sudo chown -R "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_DIR}/data"

# ── npm dependencies ───────────────────────────────────────────────────────
echo "Installing npm dependencies..."
cd "${INSTALL_DIR}"
sudo -u "${SERVICE_USER}" npm install --omit=dev
echo "  npm OK"

# ── Systemd service ────────────────────────────────────────────────────────
sudo tee /etc/systemd/system/racetracker.service > /dev/null <<EOF
[Unit]
Description=RaceTracker Node.js server
After=network.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${INSTALL_DIR}
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
Environment=PORT=3000
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable racetracker
sudo systemctl restart racetracker
echo "  racetracker service started"

# ── nginx ──────────────────────────────────────────────────────────────────
if [ -d /etc/nginx/sites-available ]; then
  sudo cp "${INSTALL_DIR}/nginx-racetracker.conf" /etc/nginx/sites-available/racetracker
  sudo ln -sf /etc/nginx/sites-available/racetracker /etc/nginx/sites-enabled/racetracker
  sudo nginx -t && sudo systemctl reload nginx
  echo "  nginx configured"
else
  echo "  nginx sites-available not found — copy nginx-racetracker.conf manually."
fi

# ── SSL via certbot ────────────────────────────────────────────────────────
if [ "${SSL}" = "--ssl" ]; then
  echo "Setting up SSL with certbot..."
  if ! command -v certbot &>/dev/null; then
    sudo apt-get install -y certbot python3-certbot-nginx
  fi
  sudo certbot --nginx -d "${HOSTNAME}" --non-interactive --agree-tos -m admin@${HOSTNAME} || true
  echo "  SSL configured (check output above for any errors)"
else
  echo ""
  echo "  TIP: Re-run with --ssl to configure HTTPS via certbot:"
  echo "       bash setup.sh --ssl"
fi

echo ""
echo "=== Setup complete ==="
echo "  App:    http://${HOSTNAME}/RaceTracker/"
echo "  Status: sudo systemctl status racetracker"
echo "  Logs:   sudo journalctl -u racetracker -f"
