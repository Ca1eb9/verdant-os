#!/usr/bin/env bash
# Host tests for the comms + sensor firmware. No ESP32 needed.
#
#   cd firmware/esp32/test_host && ./run.sh
#
# Needs: a C++17 compiler (g++ or clang++), Node, and `npm install` run at the
# repo root (for TypeScript). ArduinoJson comes from PlatformIO's download,
# so build the firmware once first (pio run -e bench), or point
# ARDUINOJSON_SRC at a checkout of ArduinoJson's src/ folder.

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
  -o out/host_test

./out/host_test out commands
node check_contract.mjs
