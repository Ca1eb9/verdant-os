# Firmware — ESP32 (PlatformIO)

## Setup

1. Install [VS Code](https://code.visualstudio.com/)
2. Open the Extensions panel (`Cmd+Shift+X` / `Ctrl+Shift+X`)
3. Search **PlatformIO IDE**, install it
4. Restart VS Code when prompted
5. Open this `firmware/` folder as the project — PlatformIO will detect `platformio.ini` and configure everything automatically

## Building & flashing

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
│                               # battery thresholds, robot ID, dock tag ID
│   └── types.h                 # Shared structs: SensorData, DriveCommand,
│                               # Command, TelemetryMsg, RobotEvent
│   ├── graph.cpp               # Farm topology stored in flash
│   ├── graph.h
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

PlatformIO downloads these automatically on first build.
