#!/usr/bin/env bash
# Tests farmnet-channel.sh against a fake nmcli: the channel it picks, and
# that FarmNet ends up running whatever fails. No Pi or WiFi needed.
#
#   bash scripts/farmnet-channel-test.sh

set -uo pipefail
cd "$(dirname "$0")"
SCRIPT="$PWD/farmnet-channel.sh"
failures=0
check() {
  if [[ $2 == "$3" ]]; then echo "  ok   $1"; else echo "  FAIL $1: got '$2', want '$3'"; failures=$((failures + 1)); fi
}

echo "channel pick"
pick() { printf '%b' "$2" | bash "$SCRIPT" --pick "$1" 2>/dev/null; }
check "busy 1 and 6: 11" "$(pick 7 '1:80\n1:60\n6:70\n')" 11
check "a network on 7 spoils 6 and 11, not 1" "$(pick 7 '7:90\n')" 1
check "a faint network doesn't move it off its channel" "$(pick 6 '6:8\n')" 6
check "a much busier current channel does" "$(pick 6 '6:90\n6:80\n1:10\n')" 11
check "5 GHz networks don't count" "$(pick 1 '36:99\n1:5\n')" 1
check "nothing seen: stays" "$(pick 11 '')" 11
check "nothing seen, off 1/6/11: channel 1" "$(pick 7 '')" 1

# A fake nmcli: the connection's state lives in files under $FAKE
FAKE=$(mktemp -d)
trap 'rm -rf "$FAKE"' EXIT
mkdir -p "$FAKE/bin"
cat > "$FAKE/bin/nmcli" <<'EOF'
#!/usr/bin/env bash
d=$FAKE
case "$*" in
  "-t connection show FarmNet") [[ -f $d/exists ]] ;;
  "-g 802-11-wireless.channel connection show FarmNet") cat "$d/channel" ;;
  "-t -f NAME connection show --active") [[ -f $d/up ]] && echo FarmNet; true ;;
  "connection down FarmNet") rm -f "$d/up" ;;
  "connection up FarmNet") [[ -f $d/up_fails ]] && exit 4; touch "$d/up" ;;
  "connection modify FarmNet 802-11-wireless.channel "*)
    [[ -f $d/modify_fails ]] && exit 4; echo "${*: -1}" > "$d/channel" ;;
  "-t -f CHAN,SIGNAL device wifi list ifname wlan0 --rescan yes")
    [[ -f $d/scan_hangs ]] && sleep 100; [[ -f $d/scan ]] && cat "$d/scan"; true ;;
  *) echo "fake nmcli: unexpected: $*" >&2; exit 2 ;;
esac
EOF
chmod +x "$FAKE/bin/nmcli"
# Short waits so a hang shows up as a fast test
run() {
  sed -e 's/^AUTOCONNECT_WAIT_S=.*/AUTOCONNECT_WAIT_S=2/' -e 's/^SCAN_TIMEOUT_S=.*/SCAN_TIMEOUT_S=2/' \
    "$SCRIPT" > "$FAKE/script.sh"
  FAKE=$FAKE PATH="$FAKE/bin:$PATH" bash "$FAKE/script.sh" "$@" > "$FAKE/log" 2>&1
}
reset() { rm -f "$FAKE"/{exists,up,channel,scan,scan_hangs,modify_fails,up_fails}; touch "$FAKE/exists" "$FAKE/up"; echo "$1" > "$FAKE/channel"; }
state() { [[ -f $FAKE/up ]] && echo "up on $(cat "$FAKE/channel")" || echo down; }

echo "boot runs"
reset 7; printf '1:80\n6:70\n' > "$FAKE/scan"; run
check "switches to the quietest" "$(state)" "up on 11"
reset 11; printf '1:80\n6:70\n' > "$FAKE/scan"; run
check "already on it: stays" "$(state)" "up on 11"
reset 7; run
check "scan finds nothing: back on its channel" "$(state)" "up on 7"
reset 7; touch "$FAKE/scan_hangs"; run
check "scan hangs: back on its channel" "$(state)" "up on 7"
reset 7; printf '1:80\n' > "$FAKE/scan"; touch "$FAKE/modify_fails"; run
check "can't set the channel: back on its channel" "$(state)" "up on 7"
reset 7; rm "$FAKE/up"; printf '1:80\n' > "$FAKE/scan"; run
check "NetworkManager hadn't started it: started anyway" "$(state)" "up on 6"
reset 7; rm "$FAKE/exists" "$FAKE/up"; run
check "no FarmNet connection: touches nothing" "$(state)" "down"
reset 7; rm "$FAKE/up"; run --ensure-up
check "--ensure-up starts it" "$(state)" "up on 7"

echo "farmnet-channel-test: $([[ $failures -eq 0 ]] && echo passed || echo FAILED)"
exit $((failures > 0))
