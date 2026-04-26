#!/usr/bin/env bash
# RaceTracker — deploy update (preserves data/ directory)
# Usage: bash update.sh

set -euo pipefail

INSTALL_DIR="/srv/RaceTracker"
SERVICE_USER="www-data"

echo "=== RaceTracker Update ==="

sudo rsync -av --delete \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='data' \
  "$(dirname "$(realpath "$0")")/" "${INSTALL_DIR}/"

echo "Installing/updating npm dependencies..."
cd "${INSTALL_DIR}"
sudo -u "${SERVICE_USER}" npm install --omit=dev

sudo systemctl restart racetracker
echo "Service restarted."
echo "Logs: sudo journalctl -u racetracker -f"
