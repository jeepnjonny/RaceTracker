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
NODE_VER=0
if command -v node &>/dev/null; then
  NODE_VER=$(node -e "process.stdout.write(process.versions.node.split('.')[0])")
fi

if [ "$NODE_VER" -lt "$NODE_MIN" ]; then
  echo "Installing Node.js 20 via NodeSource (found v${NODE_VER})..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
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
LOCATION_BLOCK='
    location /RaceTracker/ {
        proxy_pass         http://127.0.0.1:3000/;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade    $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host       $host;
        proxy_set_header   X-Real-IP  $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout  3600s;
        proxy_send_timeout  3600s;
        proxy_buffering     off;
    }'

if [ ! -d /etc/nginx/sites-available ]; then
  echo "  nginx sites-available not found — copy nginx-racetracker.conf manually."
else
  # Find an existing server block for this hostname
  EXISTING_CONF=$(grep -rl "server_name.*${HOSTNAME}" /etc/nginx/sites-enabled/ 2>/dev/null | head -1)

  if [ -n "${EXISTING_CONF}" ]; then
    # Check if our location block is already present
    if grep -q "location /RaceTracker/" "${EXISTING_CONF}"; then
      echo "  nginx: /RaceTracker/ location already present in ${EXISTING_CONF}"
    else
      echo "  nginx: injecting /RaceTracker/ location into ${EXISTING_CONF}"
      # Insert location block before the last closing brace
      sudo sed -i "$ s|^\s*}|${LOCATION_BLOCK}\n}|" "${EXISTING_CONF}"
      sudo nginx -t && sudo systemctl reload nginx
      echo "  nginx reloaded"
    fi
  else
    # No existing server block — deploy our standalone config
    echo "  nginx: no existing server block for ${HOSTNAME}, deploying standalone config"
    sudo cp "${INSTALL_DIR}/nginx-racetracker.conf" /etc/nginx/sites-available/racetracker
    sudo ln -sf /etc/nginx/sites-available/racetracker /etc/nginx/sites-enabled/racetracker
    sudo nginx -t && sudo systemctl reload nginx
    echo "  nginx configured"
  fi
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
