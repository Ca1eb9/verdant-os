# Firmware — ESP32 (PlatformIO)

## Setup

1. Install [VS Code](https://code.visualstudio.com/)
2. Open the Extensions panel (`Cmd+Shift+X` / `Ctrl+Shift+X`)
3. Search **PlatformIO IDE**, install it
4. Restart VS Code when prompted
5. Open this `firmware/` folder as the project — PlatformIO will detect `platformio.ini` and configure everything automatically

## Building & flashing

Two environments: `esp32` (full firmware, `main.cpp`) and `bench` (comms + sensor tasks with a stand-in nav task — see [COMMS-SENSOR.md](COMMS-SENSOR.md)). Pick one with `pio run -e bench` or the env switcher in the bottom toolbar.

- **Build:** Click the checkmark (✓) in the bottom toolbar, or `Cmd+Shift+B`
- **Upload:** Click the arrow (→) in the bottom toolbar, or run `pio run -t upload`
- **Serial monitor:** Click the plug icon in the bottom toolbar, or run `pio device monitor`

Make sure your ESP32 is connected via USB before uploading.

## File structure

```
firmware/
├── platformio.ini          # Board config, libraries, build settings
├── src/
│   ├── main.cpp            # setup() and loop() — task creation, queue setup
│   ├── tasks/
│   │   ├── motor_task.cpp      # Motor control — highest priority
│   │   ├── motor_task.h
│   │   ├── sensor_task.cpp     # RFID, battery ADC, obstacle
│   │   ├── sensor_task.h
│   │   ├── nav_task.cpp        # State machine, path following
│   │   ├── nav_task.h
│   │   ├── comms_task.cpp      # WiFi, MQTT pub/sub
│   │   └── comms_task.h
│   ├── utils/
│   │   ├── nav_helpers.cpp        # On-board pathfinding
│   │   └── nav_helpers.h
│   └── config.h                # WiFi creds, MQTT broker IP, pin definitions,
│                               # battery thresholds, robot ID, dock node ID
│   └── types.h                 # Shared structs: SensorData, DriveCommand,
│                               # Command, TelemetryMsg, RobotEvent
│   ├── graph.cpp               # Farm topology stored in flash
│   ├── graph.h
│   ├── globals.cpp             # Queue handles + shared flags, create_queues()
│   ├── log.h                   # LOG(tag, fmt, ...) serial logger
│   ├── secrets.example.h       # Copy to secrets.h (gitignored) for WiFi creds
│   ├── comms/comms_json.*      # JSON <-> struct, matches @farm/shared types
│   ├── drivers/                # RFID reader, VL53L4CX ToF, battery ADC
│   └── bench/bench_main.cpp    # `bench` env: test comms + sensor tasks alone
├── test_host/                  # Laptop tests; checks JSON against types.ts
├── COMMS-SENSOR.md             # Comms + sensor task design, wiring, testing
└── README.md
```

### What goes where

- **`config.h`** — all constants: WiFi SSID/password, broker IP, pin numbers, battery thresholds, timing intervals, robot ID. Nothing should be hardcoded elsewhere.
- **`types.h`** — the structs that pass through FreeRTOS queues between tasks. Every task includes this file. JSON field names in the comms task must match the TypeScript types in `@farm/shared`.
- **`tasks/`** — one file per FreeRTOS task. Each task is a standalone function that runs in an infinite loop. Tasks communicate only through queues and shared volatile flags, never by calling each other's functions.
- **`main.cpp`** — creates queues, creates tasks with `xTaskCreatePinnedToCore()`, and nothing else. `loop()` is empty.

## Libraries

Managed by PlatformIO in `platformio.ini`. Core libraries:

- **PubSubClient** — MQTT client
- **ArduinoJson** (v7) — JSON serialization for telemetry/commands
- **Adafruit PN532** — RFID reader
- **STM32duino VL53L4CX** — time-of-flight obstacle sensor

PlatformIO downloads these automatically on first build.
