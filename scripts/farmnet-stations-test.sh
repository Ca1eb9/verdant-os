#!/usr/bin/env bash
# Tests farmnet-stations.sh against a fake iw and arping. No Pi or WiFi needed.
#
#   bash scripts/farmnet-stations-test.sh

set -uo pipefail
cd "$(dirname "$0")"
SCRIPT="$PWD/farmnet-stations.sh"
failures=0
check() {
  if [[ $2 == "$3" ]]; then echo "  ok   $1"; else echo "  FAIL $1: got '$2', want '$3'"; failures=$((failures + 1)); fi
}

FAKE=$(mktemp -d)
trap 'rm -rf "$FAKE"' EXIT
mkdir -p "$FAKE/bin"
# Stations listed in $FAKE/stations; `station del` appends to $FAKE/deleted
cat > "$FAKE/bin/iw" <<'FAKEIW'
#!/usr/bin/env bash
if [[ $3 == station && $4 == dump ]]; then
  while read -r mac; do printf 'Station %s (on wlan0)\n\tinactive time:\t10 ms\n' "$mac"; done < "$FAKE/stations"
elif [[ $3 == station && $4 == del ]]; then
  echo "$5" >> "$FAKE/deleted"
  grep -vix "$5" "$FAKE/stations" > "$FAKE/s" ; mv "$FAKE/s" "$FAKE/stations"
fi
FAKEIW
# Answers for the IPs listed in $FAKE/up
cat > "$FAKE/bin/arping" <<'FAKEARP'
#!/usr/bin/env bash
grep -qx "${!#}" "$FAKE/up"
FAKEARP
chmod +x "$FAKE/bin/"*
export FAKE PATH="$FAKE/bin:$PATH" LEASES="$FAKE/leases" SLEEP=true

run() { : > "$FAKE/deleted"; bash "$SCRIPT" --rounds "$1" >/dev/null; sort "$FAKE/deleted" | tr '\n' ' '; }

printf '1 aa:aa:aa:aa:aa:01 192.168.4.10 robot-1 *\n1 AA:AA:AA:AA:AA:02 192.168.4.11 laptop *\n' > "$FAKE/leases"

echo "stations"
printf 'aa:aa:aa:aa:aa:01\naa:aa:aa:aa:aa:02\n' > "$FAKE/stations"; printf '192.168.4.10\n192.168.4.11\n' > "$FAKE/up"
check "answering stations stay" "$(run 5)" ""
printf 'aa:aa:aa:aa:aa:01\naa:aa:aa:aa:aa:02\n' > "$FAKE/stations"; printf '192.168.4.11\n' > "$FAKE/up"
check "two misses aren't enough" "$(run 2)" ""
printf 'aa:aa:aa:aa:aa:01\naa:aa:aa:aa:aa:02\n' > "$FAKE/stations"
check "a silent station goes after three" "$(run 3)" "aa:aa:aa:aa:aa:01 "
printf 'aa:aa:aa:aa:aa:03\n' > "$FAKE/stations"
check "no lease counts as silent" "$(run 3)" "aa:aa:aa:aa:aa:03 "

echo "missing tools"
PATH="$FAKE/empty" /bin/bash "$SCRIPT" --rounds 1 >/dev/null 2>&1
check "exits with an error without iw" "$?" 1

(( failures == 0 )) && echo "all passed" || { echo "$failures failed"; exit 1; }
