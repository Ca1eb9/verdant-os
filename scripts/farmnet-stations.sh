#!/usr/bin/env bash
# Drops FarmNet stations that stopped answering (farmnet-stations.service,
# docs/WIFI-SETUP.md). An ESP32 that resets or is reflashed leaves without
# saying so, and the Pi's WiFi chip keeps it listed as connected. Its join
# attempts then go unanswered (AUTH_EXPIRE on the robot), and they count as
# activity, so the stale entry never times out. This asks each station's IP
# over ARP every CHECK_S, and removes one that doesn't answer (or has no DHCP
# lease), so its next join works. A station that joined under JOIN_GRACE_S ago
# is left alone: it may not have its lease yet.
#
#   sudo bash scripts/farmnet-stations.sh              # runs until stopped
#   sudo bash scripts/farmnet-stations.sh --rounds 3   # three checks, then exit
#
# Needs iw and arping (sudo apt install iw iputils-arping).

set -uo pipefail

IFACE=wlan0
CHECK_S=10
JOIN_GRACE_S=15
LEASES=${LEASES:-/var/lib/misc/dnsmasq.leases}
IW=${IW:-iw}
ARPING=${ARPING:-arping}
SLEEP=${SLEEP:-sleep}

log() { echo "[farmnet-stations] $*"; }

# The stations the access point lists, past JOIN_GRACE_S: one MAC per line
stations() {
  "$IW" dev "$IFACE" station dump 2>/dev/null | awk -v grace="$JOIN_GRACE_S" '
    $1 == "Station" { if (mac != "" && up >= grace) print mac; mac = tolower($2); up = grace }
    $1 == "connected" && $2 == "time:" { up = $3 + 0 }
    END { if (mac != "" && up >= grace) print mac }'
}

# The IP dnsmasq leased to a MAC, if any
lease_ip() { awk -v mac="$1" 'tolower($2) == mac { print $3; exit }' "$LEASES" 2>/dev/null; }

answers() {
  local ip
  ip=$(lease_ip "$1")
  [[ -n $ip ]] && "$ARPING" -q -c 2 -w 3 -I "$IFACE" "$ip" >/dev/null 2>&1
}

check() {
  local mac
  for mac in $(stations); do
    answers "$mac" && continue
    if "$IW" dev "$IFACE" station del "$mac" >/dev/null 2>&1; then
      log "dropped $mac: no answer"
    else
      log "couldn't drop $mac ($IW dev $IFACE station del)"
    fi
  done
}

for cmd in "$IW" "$ARPING"; do
  if ! command -v "$cmd" >/dev/null; then
    log "$cmd not installed (sudo apt install iw iputils-arping): not checking stations"
    exit 1
  fi
done

rounds=-1
[[ ${1:-} == --rounds ]] && rounds=${2:-1}
log "checking $IFACE stations every ${CHECK_S} s"
while (( rounds != 0 )); do
  check
  (( rounds > 0 )) && rounds=$((rounds - 1))
  (( rounds != 0 )) && "$SLEEP" "$CHECK_S"
done
exit 0
