#!/usr/bin/env bash
# Drops FarmNet stations that stopped answering (farmnet-stations.service,
# docs/WIFI-SETUP.md). An ESP32 that resets or is reflashed leaves without
# saying so, and the Pi's WiFi chip keeps it listed as connected. Its join
# attempts then go unanswered (AUTH_EXPIRE on the robot), and they count as
# activity, so the stale entry never times out. This asks each station's IP
# over ARP every CHECK_S, and after MISSES in a row without an answer (or
# with no DHCP lease) removes it, so its next join works.
#
#   sudo bash scripts/farmnet-stations.sh              # runs until stopped
#   sudo bash scripts/farmnet-stations.sh --rounds 3   # three checks, then exit
#
# Needs iw and arping (sudo apt install iw iputils-arping).

set -uo pipefail

IFACE=wlan0
CHECK_S=20
MISSES=3            # about a minute: a device joining has that long to get a lease
LEASES=${LEASES:-/var/lib/misc/dnsmasq.leases}
IW=${IW:-iw}
ARPING=${ARPING:-arping}
SLEEP=${SLEEP:-sleep}

log() { echo "[farmnet-stations] $*"; }

declare -A missed=()

# The stations the access point lists: one MAC per line
stations() { "$IW" dev "$IFACE" station dump 2>/dev/null | awk '$1 == "Station" { print tolower($2) }'; }

# The IP dnsmasq leased to a MAC, if any
lease_ip() { awk -v mac="$1" 'tolower($2) == mac { print $3; exit }' "$LEASES" 2>/dev/null; }

answers() {
  local ip
  ip=$(lease_ip "$1")
  [[ -n $ip ]] && "$ARPING" -q -c 2 -w 3 -I "$IFACE" "$ip" >/dev/null 2>&1
}

check() {
  local mac
  declare -A seen=()
  for mac in $(stations); do
    seen[$mac]=1
    if answers "$mac"; then
      missed[$mac]=0
      continue
    fi
    missed[$mac]=$(( ${missed[$mac]:-0} + 1 ))
    if (( missed[$mac] >= MISSES )); then
      if "$IW" dev "$IFACE" station del "$mac" >/dev/null 2>&1; then
        log "dropped $mac: no answer for $(( MISSES * CHECK_S )) s"
      else
        log "couldn't drop $mac ($IW dev $IFACE station del)"
      fi
      unset "missed[$mac]"
    fi
  done
  # Gone on its own: start afresh if it comes back
  for mac in "${!missed[@]}"; do [[ -n ${seen[$mac]:-} ]] || unset "missed[$mac]"; done
}

for cmd in "$IW" "$ARPING"; do
  if ! command -v "$cmd" >/dev/null; then
    log "$cmd not installed (sudo apt install iw iputils-arping): not checking stations"
    exit 1
  fi
done

rounds=-1
[[ ${1:-} == --rounds ]] && rounds=${2:-1}
log "checking $IFACE stations every ${CHECK_S} s, dropping after $MISSES misses"
while (( rounds != 0 )); do
  check
  (( rounds > 0 )) && rounds=$((rounds - 1))
  (( rounds != 0 )) && "$SLEEP" "$CHECK_S"
done
exit 0
