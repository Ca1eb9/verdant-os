#!/usr/bin/env bash
# Updates the Pi to the latest code and restarts the farm services.
#
#   sudo bash /opt/verdant-os/scripts/pi-deploy.sh            # pull the current branch
#   sudo bash /opt/verdant-os/scripts/pi-deploy.sh <branch>   # switch branch first
#
# Needs the one-time setup in docs/PI-SERVICES.md: the farm user, the repo
# at /opt/verdant-os and the env files in /etc/verdant/.

set -euo pipefail

REPO=/opt/verdant-os
SERVICES=(farm-orchestrator farm-ingester farm-shelf-bridge farm-dashboard)

if [[ $EUID -ne 0 ]]; then
  echo "Run with sudo." >&2
  exit 1
fi

# The repo and the builds belong to the service user, never root.
as_farm() { sudo -u farm -H "$@"; }
cd "$REPO"

echo "== code"
as_farm git fetch --quiet origin
if [[ $# -gt 0 ]]; then as_farm git switch "$1"; fi
as_farm git pull --ff-only

# npm ci replaces node_modules under the running services. The robots carry
# on without the Pi and report their real state when it's back.
echo "== stop services"
systemctl stop "${SERVICES[@]}" 2>/dev/null || true

echo "== farm-controller"
as_farm npm ci --no-audit --no-fund
as_farm npm run build:shared

echo "== dashboard (takes a few minutes)"
# Build with the service's env file: NEXT_PUBLIC_* values are fixed at build time.
as_farm bash -c 'cd web && set -a && . /etc/verdant/dashboard.env && set +a &&
  npm ci --no-audit --no-fund && npm run build'

echo "== systemd units"
changed=0
for unit in deploy/systemd/*.service; do
  dest="/etc/systemd/system/$(basename "$unit")"
  if ! cmp -s "$unit" "$dest"; then
    install -m 644 "$unit" "$dest"
    echo "updated $dest"
    changed=1
  fi
done
if [[ $changed -eq 1 ]]; then systemctl daemon-reload; fi
systemctl enable --quiet "${SERVICES[@]}"

echo "== start"
systemctl start "${SERVICES[@]}"
sleep 3
systemctl --no-pager --lines=0 status "${SERVICES[@]}" || {
  echo "A service isn't running. See: journalctl -u <service> -n 50" >&2
  exit 1
}
echo "Deployed $(as_farm git log -1 --format='%h %s')"
