#!/usr/bin/env bash
# Tests pi-env-sync.sh against a scratch /etc/verdant. No Pi needed.
#
#   bash scripts/pi-env-sync-test.sh

set -uo pipefail
cd "$(dirname "$0")"
SCRIPT="$PWD/pi-env-sync.sh"
EXAMPLES="$PWD/../deploy/env"
failures=0
check() {
  if [[ $2 == "$3" ]]; then echo "  ok   $1"; else echo "  FAIL $1: got '$2', want '$3'"; failures=$((failures + 1)); fi
}

DIR=$(mktemp -d)
trap 'rm -rf "$DIR"' EXIT
run() { ENV_DIR="$DIR" bash "$SCRIPT" > "$DIR/out" 2>&1; }

echo "a Pi with every .env missing"
run
check "each one created from its example" "$(ls "$DIR" | grep -c '\.env$')" "$(ls "$EXAMPLES" | grep -c '\.env\.example$')"
check "identical to the example" "$(cmp -s "$DIR/dashboard.env" "$EXAMPLES/dashboard.env.example" && echo same)" "same"
check "readable by its owner and group only" "$(stat -c %a "$DIR/dashboard.env")" "640"

echo "an older .env missing variables"
# The operator's own values, a variable commented out, and nothing else
cat > "$DIR/dashboard.env" <<'ENV'
NEXT_PUBLIC_FARM_ID=north-farm
NEXT_PUBLIC_FARM_NAME="North Farm"
#NEXT_PUBLIC_DASHBOARD_API_URL=http://192.168.4.1:3001
SUPABASE_URL=https://example.supabase.co
ENV
before=$(cat "$DIR/dashboard.env")
run
after=$(cat "$DIR/dashboard.env")
check "existing lines unchanged" "${after:0:${#before}}" "$before"
check "the farm id kept" "$(grep -c '^NEXT_PUBLIC_FARM_ID=north-farm$' "$DIR/dashboard.env")" "1"
check "a missing variable added with its default" "$(grep -c '^NEXT_PUBLIC_JOG_WHILE_INITIALIZING=false$' "$DIR/dashboard.env")" "1"
check "its comment from the example comes along" "$(grep -B1 '^NEXT_PUBLIC_JOG_WHILE_INITIALIZING=' "$DIR/dashboard.env" | head -1 | cut -c1)" "#"
check "a commented-out variable left alone" "$(grep -c 'NEXT_PUBLIC_DASHBOARD_API_URL=' "$DIR/dashboard.env")" "1"
check "nothing already there added twice" "$(grep -c '^SUPABASE_URL=' "$DIR/dashboard.env")" "1"
check "says what it added" "$(grep -c '^dashboard.env: added .*NEXT_PUBLIC_JOG_WHILE_INITIALIZING' "$DIR/out")" "1"

echo "run again"
copy=$(cat "$DIR/dashboard.env")
run
check "changes nothing" "$(cat "$DIR/dashboard.env")" "$copy"
check "reports it up to date" "$(grep -c '^dashboard.env: up to date' "$DIR/out")" "1"

echo "without write access"
chmod 500 "$DIR"
if [[ $EUID -eq 0 ]]; then
  echo "  skip (root writes anyway)"
else
  ENV_DIR="$DIR" bash "$SCRIPT" > "$DIR/../out.$$" 2>&1; code=$?
  check "refuses, asking for sudo" "$code" "1"
  rm -f "$DIR/../out.$$"
fi
chmod 700 "$DIR"

if (( failures )); then echo "pi-env-sync-test: $failures failed"; exit 1; fi
echo "pi-env-sync-test: passed"
