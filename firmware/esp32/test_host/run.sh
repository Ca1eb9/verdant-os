#!/usr/bin/env bash
# Host tests for the firmware. No ESP32 needed.
#
#   cd firmware/esp32/test_host && ./run.sh
#
# Needs: a C++17 compiler (g++ or clang++), Node, and `npm install` and
# `npm run build:shared` run at the repo root (TypeScript, navigation.ts).
# ArduinoJson comes from PlatformIO's download, so build the firmware once
# first (pio run -e bench), or point ARDUINOJSON_SRC at a checkout of
# ArduinoJson's src/ folder.

set -euo pipefail
cd "$(dirname "$0")"

AJ="${ARDUINOJSON_SRC:-}"
if [[ -z "$AJ" ]]; then
  for env in bench esp32; do
    if [[ -f "../.pio/libdeps/$env/ArduinoJson/src/ArduinoJson.h" ]]; then
      AJ="../.pio/libdeps/$env/ArduinoJson/src"
      break
    fi
  done
fi
if [[ -z "$AJ" ]]; then
  echo "ArduinoJson not found. Run 'pio run -e bench' once, or set ARDUINOJSON_SRC." >&2
  exit 1
fi

CXX="${CXX:-$(command -v g++ || command -v clang++)}"
mkdir -p out
"$CXX" -std=c++17 -Wall -Wextra -DARDUINOJSON_USE_LONG_LONG=1 \
  -I../src -I"$AJ" \
  host_test.cpp ../src/comms/comms_json.cpp ../src/drivers/battery.cpp \
  ../src/drivers/env_sensor.cpp \
  -o out/host_test

./out/host_test out commands
node check_contract.mjs

# Flash graph + nav helpers, against the farm and a tie-break fixture.
node ../tools/gen_graph.mjs --check
node ../tools/gen_graph.mjs --topology fixtures/tie_topology.json --out out/tie_graph.cpp
NAV_SRC=(nav_test.cpp ../src/utils/nav_helpers.cpp)
"$CXX" -std=c++17 -Wall -Wextra -I../src "${NAV_SRC[@]}" ../src/graph.cpp -o out/nav_test
"$CXX" -std=c++17 -Wall -Wextra -I../src "${NAV_SRC[@]}" out/tie_graph.cpp -o out/nav_test_tie
./out/nav_test out/nav_farm.json
./out/nav_test_tie out/nav_tie.json
node check_nav.mjs out/nav_farm.json ../../../farm-controller/topology.json \
  out/nav_tie.json fixtures/tie_topology.json

# Robot state machine, against the farm and (unreachable targets) the fixture.
CORE_SRC=(nav_core_test.cpp ../src/nav/nav_core.cpp ../src/utils/nav_helpers.cpp
  ../src/comms/comms_json.cpp)
CORE_FLAGS=(-std=c++17 -Wall -Wextra -DARDUINOJSON_USE_LONG_LONG=1 -I../src -I"$AJ")
"$CXX" "${CORE_FLAGS[@]}" "${CORE_SRC[@]}" ../src/graph.cpp -o out/nav_core_test
"$CXX" "${CORE_FLAGS[@]}" -DTIE_FIXTURE "${CORE_SRC[@]}" out/tie_graph.cpp -o out/nav_core_test_tie
./out/nav_core_test
./out/nav_core_test_tie

# Motion hooks (drive commands, elevator rides, missed tags) and survival overrides.
"$CXX" "${CORE_FLAGS[@]}" motion_test.cpp ../src/nav/motion.cpp "${CORE_SRC[@]:1}" \
  ../src/graph.cpp -o out/motion_test
"$CXX" "${CORE_FLAGS[@]}" survival_test.cpp ../src/nav/survival.cpp "${CORE_SRC[@]:1}" \
  ../src/graph.cpp -o out/survival_test
./out/motion_test
./out/survival_test
