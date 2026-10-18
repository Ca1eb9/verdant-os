#!/usr/bin/env bash
# Starts FarmNet on the quietest of 2.4 GHz channels 1, 6 and 11, once at
# boot (farmnet-channel.service, docs/WIFI-SETUP.md). The access point has to
# be off to scan, so FarmNet drops for about 10 s while this runs.
#
#   sudo bash scripts/farmnet-channel.sh               # scan, pick, start FarmNet
#   sudo bash scripts/farmnet-channel.sh --ensure-up   # start FarmNet if it isn't
#   bash scripts/farmnet-channel.sh --pick <current> < scan
#                                                      # pick from "CHAN:SIGNAL" lines
#
# FarmNet is never left down: whatever fails, it starts again on the channel
# it had. The unit's ExecStopPost checks that once more.

set -uo pipefail

CON=FarmNet
IFACE=wlan0
AUTOCONNECT_WAIT_S=30   # NetworkManager's own start of FarmNet, before scanning
SCAN_TIMEOUT_S=20
# Stay on the current channel unless another is quieter by more than this
# share of its score, or this many points: a small difference isn't worth it.
KEEP_SHARE=0.25
KEEP_POINTS=10

log() { echo "[farmnet-channel] $*"; }

# Reads "CHAN:SIGNAL" lines (nmcli -t -f CHAN,SIGNAL), prints each candidate's
# score to stderr and the channel to use to stdout. A network adds its signal
# (0-100) to every candidate within 4 channels of it, less the further away.
pick_channel() {
  awk -F: -v cur="$1" -v share="$KEEP_SHARE" -v points="$KEEP_POINTS" '
    $1 ~ /^[0-9]+$/ && $1 >= 1 && $1 <= 14 && $2 ~ /^[0-9]+$/ {
      seen++
      for (k = 1; k <= 11; k += 5) {
        d = $1 - k; if (d < 0) d = -d
        if (d < 5) score[k] += $2 * (5 - d) / 5
      }
    }
    END {
      line = ""
      for (k = 1; k <= 11; k += 5) {
        s = score[k] + 0
        line = line sprintf(" %d:%d", k, s)
        if (best == "" || s < bs) { best = k; bs = s }
      }
      printf "%d networks seen, scores%s\n", seen + 0, line > "/dev/stderr"
      if (cur == 1 || cur == 6 || cur == 11) {
        margin = bs * share; if (margin < points) margin = points
        if (score[cur] + 0 - bs <= margin) best = cur
      }
      print best
    }'
}

is_up() { nmcli -t -f NAME connection show --active 2>/dev/null | grep -qx "$CON"; }

ensure_up() {
  is_up && return 0
  log "starting $CON"
  nmcli connection up "$CON" >/dev/null || log "couldn't start $CON (nmcli connection up $CON)"
}

case "${1:-}" in
  --pick) pick_channel "${2:-0}"; exit 0 ;;
  --ensure-up) ensure_up; exit 0 ;;
esac

if ! nmcli -t connection show "$CON" >/dev/null 2>&1; then
  log "no $CON connection (docs/WIFI-SETUP.md step 2): nothing to do"
  exit 0
fi
trap ensure_up EXIT
trap 'exit 1' TERM INT

current=$(nmcli -g 802-11-wireless.channel connection show "$CON")
for ((i = 0; i < AUTOCONNECT_WAIT_S; i++)); do is_up && break; sleep 1; done

nmcli connection down "$CON" >/dev/null 2>&1
scan=$(timeout "$SCAN_TIMEOUT_S" nmcli -t -f CHAN,SIGNAL device wifi list ifname "$IFACE" --rescan yes 2>/dev/null)
if [[ -z $scan ]]; then
  log "scan found nothing or failed: staying on channel $current"
  exit 0
fi

# The scores (stderr) then the pick, the last line
out=$(printf '%s\n' "$scan" | pick_channel "$current" 2>&1)
log "${out%$'\n'*}"
best=${out##*$'\n'}
if [[ ! $best =~ ^(1|6|11)$ ]]; then
  log "couldn't pick a channel: staying on channel $current"
elif [[ $best == "$current" ]]; then
  log "staying on channel $current"
elif nmcli connection modify "$CON" 802-11-wireless.channel "$best"; then
  log "channel $current -> $best"
else
  log "couldn't set channel $best: staying on channel $current"
fi
