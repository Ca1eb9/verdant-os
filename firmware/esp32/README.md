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
│   ├── main.cpp            # setup(): queues + the four tasks; loop() does nothing
│   ├── config.h            # Every pin, threshold and timing constant
│   ├── types.h             # Queue structs + shared flags: the task interfaces
│   ├── globals.cpp         # Queue handles + shared flags, create_queues()
│   ├── graph.h             # Flash graph types
│   ├── graph.cpp           # GENERATED from topology.json (tools/gen_graph.mjs)
│   ├── log.h               # LOG(tag, fmt, ...) serial logger
│   ├── secrets.example.h   # Copy to secrets.h (gitignored) for WiFi creds
│   ├── tasks/
│   │   ├── motor_task.*        # Motors (highest priority); placeholder for now
│   │   ├── sensor_task.*       # RFID, battery ADC, obstacle
│   │   ├── nav_task.*          # Runs the state machine on the queues
│   │   └── comms_task.*        # WiFi, MQTT pub/sub
│   ├── nav/
│   │   ├── nav_core.*          # Robot state machine (pure C++, host-tested)
│   │   ├── motion.*            # Motion hooks -> DriveCommands, missed-tag faults
│   │   ├── survival.*          # Battery thresholds, motor cutoff, obstacle events
│   │   └── task_context.h      # Current/kept task, stop latch, paused status
│   ├── utils/nav_helpers.*     # Dijkstra, heading, turns (match navigation.ts)
│   ├── comms/comms_json.*      # JSON <-> struct, matches @farm/shared types
│   ├── drivers/                # RFID reader, VL53L4CX ToF, battery ADC
│   ├── bench/bench_main.cpp    # `bench` env: test comms + sensor tasks alone
│   └── wifitest/               # `wifitest` env: WiFi diagnostics
├── tools/gen_graph.mjs     # topology.json -> src/graph.cpp
├── test_host/              # Laptop tests (see below)
├── docs/state-machine.md   # Robot state machine diagrams
├── COMMS-SENSOR.md         # Comms + sensor task design, wiring, testing
└── README.md
```

### What goes where

- **`config.h`** — all constants: WiFi SSID/password, broker IP, pin numbers, battery thresholds, timing intervals, robot ID. Nothing should be hardcoded elsewhere.
- **`types.h`** — the structs that pass through FreeRTOS queues between tasks. Every task includes this file. JSON field names in the comms task must match the TypeScript types in `@farm/shared`.
- **`tasks/`** — one file per FreeRTOS task. Each task is a standalone function that runs in an infinite loop. Tasks communicate only through queues and shared volatile flags, never by calling each other's functions.
- **`main.cpp`** — creates queues, creates tasks with `xTaskCreatePinnedToCore()`, and nothing else. `loop()` deletes itself; all logic runs in tasks.
- **`nav/`, `utils/`, `comms/`** — logic with no Arduino or FreeRTOS calls, so `test_host/` can run it on a laptop.

## Robot state machine

The contract with the orchestrator is [docs/firmware-architecture.md](../../docs/firmware-architecture.md); the diagrams are in [docs/state-machine.md](docs/state-machine.md). `nav/nav_core` implements it. The nav task feeds it tags, battery readings, commands and the time, and it reports through a `NavOutput`: events, and motion hooks that `nav/motion` turns into `DriveCommand`s.

The robot has a single drive motor and no encoder, so it never turns: it faces `ROBOT_HEADING`, away from the dock (so it backs onto the charger), and `heading` never changes. `NavCore` works out how to drive each edge (`EdgeDrive`): forward at `CRUISE_SPEED` toward the way it faces, backward otherwise, until the next tag. On an elevator ride it stays put for `ELEVATOR_WAIT_MS` per level (consecutive elevator edges are one ride), then drives off the opposite way to how it drove on, to the elevator tag on the last level. Turns to the side are a placeholder: the robot stops with a fault. `creep` drives forward at `CREEP_SPEED` until the first tag.

ToF approach: while driving an edge it slows to `APPROACH_SPEED` once anything ahead is inside `SLOW_ZONE_CM`. After the elevator tag it creeps onto the platform until the end wall is `ELEVATOR_STOP_CM` away, and `start_docking` backs onto the dock until `DOCK_STOP_CM`. For those it lowers that side's stop distance (`Motion::stop_cm()`, written to `g_obstacle_*_stop_cm` for the sensor task), so the flag doesn't stop it at `OBSTACLE_STOP_CM`. Each elevator and dock tag must be read while the wall is still beyond `OBSTACLE_STOP_CM`. The nav loop calls `Motion::check()` every cycle and passes any fault to `NavCore::fault()`:

| Fault | When |
|---|---|
| `missed tag` | `MISSED_TAG_TIMEOUT_MS` of driving with no tag. Time with the motors held off (obstacle ahead, motor cutoff) doesn't count |
| `no tag found` | `CREEP_TIMEOUT_MS` of creeping after boot (the robot stays `initializing`) |
| `couldn't get onto the elevator` / `the dock` | the end wall not reached after `APPROACH_TIMEOUT_MS` of driving |
| `turn needed: not supported yet` | the next node is to the side (placeholder) |

`nav/survival` runs at the top of every nav loop, before anything else (thresholds in `config.h`, "Survival overrides"):

| Check | What happens |
|---|---|
| battery at or below `BATTERY_WARN_PCT` | `battery_low`, once until the next charge complete; not while docking or charging |
| battery at or below `BATTERY_RETURN_PCT` | `NavCore::survival_return()`: `battery_critical` and back to the dock, keeping the task. Ignored while stopped, in manual and on a dock trip |
| battery at or below `BATTERY_CUTOFF_PCT` | `g_motor_kill_flag` set in every status, until the battery is back above `BATTERY_RETURN_PCT`. Whenever the robot is driving itself, `error` ("motor cutoff"), so it doesn't wait forever with the motors off. Not while charging |
| obstacle flag ahead while `en_route` or `returning_to_dock` | `obstacle_detected` once, then `path_blocked` after `PATH_BLOCKED_TIMEOUT_MS`; status kept |

Hooks and inputs still owned by later work (placeholders for now):

| Hook / input | Owner |
|---|---|
| `on_charge_contact()` | Dock sequence |
| `motor_task` | Motor control |

Task state is RAM only: the robot never writes to flash. A rebooted robot starts with no task and the orchestrator requeues it.

## Status LED

The onboard NeoPixel (GPIO38) shows the robot's state: colour is the status, the animation is the detail, and short flashes show what just happened. `show_status_led()` in `tasks/nav_task.cpp`; timings and brightness in `config.h`.

| Status | LED |
|---|---|
| `initializing` | White, slow breathe |
| `idle` | Green, dim |
| `en_route` | Blue |
| `working` | Cyan (water), magenta (grow), yellow (harvest), green (wait); dim to full over the action |
| `returning_to_dock` | Amber |
| `docking` | Amber, fast blink |
| `charging` | Breathes, red to green with battery % |
| `stopped` | Red, dim |
| `error` | Red, fast blink |
| `manual` | Purple, bright flash on each jog |

| Flash | Meaning |
|---|---|
| White blip | Known tag read |
| Red blip | Tag not in `topology.json` |
| Two dim white blips | Command ignored (the serial log says why) |
| Dark gap every 2 s | MQTT offline |
| Orange blink while moving | Obstacle flag set |
| Amber blip every 5 s | Battery at or below 20% |

## Flash graph

`src/graph.cpp` is generated from `farm-controller/topology.json`, keeping node and edge order exactly so on-board routes match the orchestrator's, ties included. After changing `topology.json`:

```bash
cd firmware/esp32 && node tools/gen_graph.mjs
```

and commit both files. The host tests fail if they're out of sync.

## Host tests (no ESP32)

```bash
npm install && npm run build:shared        # once, at the repo root
cd firmware/esp32 && pio run -e bench      # once, downloads ArduinoJson
cd test_host && ./run.sh
```

Needs g++ or clang++ (on Windows, MSYS2's `mingw-w64-ucrt-x86_64-gcc`). `run.sh` checks:

- the JSON the firmware sends and parses against `types.ts` (see [COMMS-SENSOR.md](COMMS-SENSOR.md));
- every route, heading and turn against `navigation.ts`, on the farm and on a fixture full of equal-cost ties (`test_host/fixtures/`);
- the state machine (`nav_core_test.cpp`): command and sensor sequences, with every event checked to go out before its status change;
- the motion hooks (`motion_test.cpp`): the drive commands they send, the ToF slow zone and approaches, and each fault;
- the survival overrides (`survival_test.cpp`): each battery threshold in each status, and the obstacle events.

## Libraries

Managed by PlatformIO in `platformio.ini`. Core libraries:

- **PubSubClient** — MQTT client
- **ArduinoJson** (v7) — JSON serialization for telemetry/commands
- **Adafruit PN532** — RFID reader
- **STM32duino VL53L4CX** — time-of-flight obstacle sensor

PlatformIO downloads these automatically on first build.
