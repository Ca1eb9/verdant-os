# Firmware — ESP32 (PlatformIO)

## Setup

1. Install [VS Code](https://code.visualstudio.com/)
2. Open the Extensions panel (`Cmd+Shift+X` / `Ctrl+Shift+X`)
3. Search **PlatformIO IDE**, install it
4. Restart VS Code when prompted
5. Open this `firmware/` folder as the project — PlatformIO will detect `platformio.ini` and configure everything automatically

## Building & flashing

Two environments: `esp32` (full firmware, `main.cpp`) and `bench` (comms + sensor tasks with a stand-in nav task — see [COMMS-SENSOR.md](COMMS-SENSOR.md)). Two diagnostics run alone: `wifitest` (WiFi) and `padtest` (pairs an Xbox controller over Bluetooth LE and prints its stick and buttons). Pick one with `pio run -e bench` or the env switcher in the bottom toolbar.

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
│   │   ├── motor_task.*        # Drive motor (highest priority)
│   │   ├── sensor_task.*       # RFID, battery ADC, obstacle
│   │   ├── nav_task.*          # Runs the state machine on the queues
│   │   ├── comms_task.*        # WiFi, MQTT pub/sub
│   │   └── pad_task.*          # Xbox controller over Bluetooth LE
│   ├── nav/
│   │   ├── nav_core.*          # Robot state machine (pure C++, host-tested)
│   │   ├── motion.*            # Motion hooks -> DriveCommands, missed-tag faults
│   │   ├── survival.*          # Battery thresholds, motor cutoff, obstacle events
│   │   └── task_context.h      # Current/kept task, stop latch, paused status
│   ├── motor/motor_core.*      # Motor rules: timed drives, reversal ramp, safety flags
│   ├── pad/pad_core.*          # Controller rules: stick, centre-first, buttons
│   ├── utils/nav_helpers.*     # Dijkstra, heading, turns (match navigation.ts)
│   ├── comms/comms_json.*      # JSON <-> struct, matches @farm/shared types
│   ├── drivers/                # RFID reader, VL53L4CX ToF, battery ADC, AHT20, motor driver
│   ├── bench/bench_main.cpp    # `bench` env: test comms + sensor tasks alone
│   ├── wifitest/               # `wifitest` env: WiFi diagnostics
│   └── padtest/                # `padtest` env: Xbox controller pairing test
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
- **`nav/`, `motor/`, `pad/`, `utils/`, `comms/`** — logic with no Arduino or FreeRTOS calls, so `test_host/` can run it on a laptop.

## Robot state machine

The contract with the orchestrator is [docs/firmware-architecture.md](../../docs/firmware-architecture.md); the diagrams are in [docs/state-machine.md](docs/state-machine.md). `nav/nav_core` implements it. The nav task feeds it tags, battery readings, commands and the time, and it reports through a `NavOutput`: events, and motion hooks that `nav/motion` turns into `DriveCommand`s.

The robot has a single drive motor and no encoder, so it never turns: it faces `ROBOT_HEADING`, away from the dock (so it backs onto the charger), and `heading` never changes. `NavCore` works out how to drive each edge (`EdgeDrive`): forward at `CRUISE_SPEED` toward the way it faces, backward otherwise, until the next tag. On an elevator ride it stays put for `ELEVATOR_WAIT_MS` per level (consecutive elevator edges are one ride), then drives off the opposite way to how it drove on, to the elevator tag on the last level. Turns to the side are a placeholder: the robot stops with a fault. `creep` drives forward at `CREEP_SPEED` until the first tag.

ToF approach: while driving an edge it slows to `APPROACH_SPEED` once anything ahead is inside `SLOW_ZONE_CM`, and so does driving by hand (a jog or the controller's drive) for the rest of its pulse; a pulse started in the slow zone starts slow. After the elevator tag it creeps onto the platform until the end wall is `ELEVATOR_STOP_CM` away, and `start_docking` backs onto the dock until `DOCK_STOP_CM`. For those it lowers that side's stop distance (`Motion::stop_cm()`, written to `g_obstacle_*_stop_cm` for the sensor task), so the flag doesn't stop it at `OBSTACLE_STOP_CM`. Each elevator and dock tag must be read while the wall is still beyond `OBSTACLE_STOP_CM`. The nav loop calls `Motion::check()` every cycle and passes any fault to `NavCore::fault()`:

| Fault | When |
|---|---|
| `missed tag` | `MISSED_TAG_TIMEOUT_MS` of driving with no tag. Time with the motors held off (obstacle ahead, motor cutoff) doesn't count |
| `no tag found` | `CREEP_TIMEOUT_MS` of creeping after boot (the robot stays `initializing`) |
| `couldn't get onto the elevator` / `the dock` | the end wall not reached after `APPROACH_TIMEOUT_MS` of driving |
| `can't charge: no charge contact on the dock` | at `DOCK_STOP_CM` for `CHARGE_CONTACT_TIMEOUT_MS` with the contact still open (dead charger, dirty pads): something the robot can't fix, so the orchestrator raises an alert |
| `turn needed: not supported yet` | the next node is to the side (placeholder) |

`nav/survival` runs at the top of every nav loop, before anything else (thresholds in `config.h`, "Survival overrides"):

| Check | What happens |
|---|---|
| battery at or below `BATTERY_WARN_PCT` | `battery_low`, once until the next charge complete; not while docking or charging |
| battery at or below `BATTERY_RETURN_PCT` | `NavCore::survival_return()`: `battery_critical` and back to the dock, keeping the task. Ignored while stopped, in manual and on a dock trip |
| battery at or below `BATTERY_CUTOFF_PCT` | `g_motor_kill_flag` set in every status, until the battery is back above `BATTERY_RETURN_PCT`. Whenever the robot is driving itself, `error` ("motor cutoff"), so it doesn't wait forever with the motors off. Not while charging |
| obstacle flag ahead while `en_route`, `returning_to_dock` or a jog pulse in `manual` | `obstacle_detected` once, then `path_blocked` after `PATH_BLOCKED_TIMEOUT_MS`; status kept |

Charge contact: while `docking` or `charging` (only then, `g_charge_sense_on`), the sensor task reads `PIN_CHARGE_SENSE` every loop against `CHARGE_CONTACT_V` (1.8–2.3 V docked, under 0.5 V off; [docs/wiring/robot.md](../../docs/wiring/robot.md)). The state is only known after `CHARGE_CONTACT_COUNT` readings agree, and changes only after as many, since the pogo pins bounce. The nav task acts on the state, not its change:

| Contact | Status | What happens |
|---|---|---|
| closed | `docking` | `on_charge_contact()`: brakes, `dock_connected` (and `task_complete` for a dock task), `charging` |
| open | `charging` | `on_charge_lost()`, knocked off the charger: at or above `CHARGE_RESUME_PCT` (40%), `charge_complete` and on as after a full charge; below it, back to `docking`, backing on slowly until `DOCK_STOP_CM` |

A robot built without the docking parts never closes the contact, so a dock trip ends in the `can't charge` fault.

To bench-test the contact, set `CHARGE_SENSE_ALWAYS` in `config.h`: the pin is then read in every status, and each change is logged with its voltage (`charge contact closed (2.21 V)`). Nothing else changes: the robot still only acts on it while docking or charging, and publishes `dock_connected` only then.

## Motor driver

An Adafruit DRV8871 drives the one motor from `PIN_MOTOR_IN1` and `PIN_MOTOR_IN2` (GPIO 5 and 6). Wiring, power and the reasons for each part are in [docs/wiring/robot.md](../../docs/wiring/robot.md).

| Speed | IN1 | IN2 |
|---|---|---|
| Forward | high | PWM: low for the speed's share of each cycle |
| Backward | PWM: low for the speed's share of each cycle | high |
| Stop | high | high (brake: both motor terminals shorted) |

This is the DRV8871's slow-decay mode: between pulses the motor is briefly braked, so it gets about speed / 255 of the battery voltage. In fast decay (the other input low instead), each off-time drives the motor's current back against the battery, and below about half speed the motor gets nothing.

The chip's inputs have pull-downs, so the motor coasts while the ESP32 boots. Positive speeds must drive the robot the way it faces (`ROBOT_HEADING`); if it goes the other way, swap the motor's red and black wires.

The motor task (`tasks/motor_task`) applies `motor/motor_core` every `MOTOR_LOOP_MS`: the newest `DriveCommand` wins, a timed Drive (a jog pulse) ends by itself, reversing slows to 0 over `REVERSE_RAMP_MS` first, and the kill flag or the obstacle flag on the side it's driving toward holds the motor off until it clears. Every stop slows to 0 over `STOP_RAMP_MS` (a stop command, a jog pulse running out, a tag, an obstacle, the motor cutoff), so the robot doesn't jerk; once stopped, the motor is braked rather than left to coast. The robot rolls on a little while it slows, so `OBSTACLE_STOP_CM` needs to allow for it. The exceptions are reaching the elevator or dock wall (`ELEVATOR_STOP_CM`, `DOCK_STOP_CM`) and the dock's charge contacts touching: it's already at `APPROACH_SPEED` there, and brakes at once rather than rolling on.

**Bench settings** in `config.h`, each logged at boot while off. Turn them back on before running on the farm:

| Setting | Off (`false`) |
|---|---|
| `OBSTACLE_FAILSAFE` | A missing or dead ToF sensor no longer holds the motor (no sensors plugged in) |
| `BATTERY_FAILSAFE` | No motor cutoff at low battery (battery divider not wired: it reads 0%). The low-battery warning and forced return still apply |
| `BOOT_CREEP` | After boot the robot waits in place for a tag instead of creeping forward for up to `CREEP_TIMEOUT_MS`; the controller can still drive it |

Bench check, wheels off the ground, with the serial monitor open (`motor` lines):

1. Jog forward and backward from the dashboard or the controller: the wheel turns each way and, 500 ms after the last jog (250 ms after letting go of the stick), slows to a stop. The further the stick is pushed, the faster it turns.
2. Forward then backward straight away: it slows before reversing.
3. Hand in front of the front sensor: a forward jog does nothing (`held off: obstacle`), a backward one still drives. Same at the rear, the other way round.
4. An obstacle during a reversal holds it at 0 once it has slowed down.

## Bluetooth controller

An Xbox Wireless Controller (model 1914, firmware 5.x) pairs with the robot itself over Bluetooth LE; the ESP32-S3 has no classic Bluetooth, so older controllers and firmware won't connect. `tasks/pad_task` turns it into commands on the same queue the dashboard's arrive on, so the rules are the dashboard's ([firmware-architecture.md](../../docs/firmware-architecture.md#manual-control)), with two differences: the stick drives at a speed rather than a fixed-speed `jog` (a robot-only `Drive` command, `NavCore::drive()`), and it also takes over a dock trip (its operator is at the robot); leaving manual picks the trip back up.

| Input | Does |
|---|---|
| Left stick up / down, past `PAD_DEADZONE` | Drive forward / backward, from `PAD_MIN_SPEED` just past the deadzone to `PAD_MAX_SPEED` fully pushed. Each drive lasts `PAD_PULSE_MS` (250 ms, half a dashboard jog, so it stops sooner on release); a held stick sends another every `PAD_DRIVE_INTERVAL_MS`, or at once when the speed changes by `PAD_SPEED_STEP` |
| **B** | `stop` |
| **A** | `resume`: hand the robot back |

**Pairing:** turn the controller on and hold its pair button (top edge) until the Xbox light flashes fast. Until `PAD_ADDRESS` is set, the robot connects to any Xbox controller in pairing mode, and the light goes solid. After that the Xbox button alone reconnects it. A controller that was paired with a console or PC goes back to that first: turn that device's Bluetooth off.

**Pin the controller.** Copy the address from the `controller connected (...)` log line (printed on every connection, the first included) into `secrets.h` as `#define PAD_ADDRESS "44:16:22:5e:b2:d4"` and reflash: from then on only that controller can connect. If it no longer connects, check the address, or remove the line to accept any controller again. The library only pins public addresses: if the log line says the controller has a random address, pinning can't work.

**The stick only starts driving from the centre.** If it is already pushed when the controller connects, after **B**, or after the link stalled, let go first.

**Losing the controller.** A held stick sends nothing, and a dead controller takes about 3 s to show as disconnected (measured). So the task reads the controller's battery level every `PAD_LOOP_MS` and only acts on the stick after an answer. No answer, no drive: the robot stops when its last 250 ms drive pulse runs out.

**When it looks for a controller.** Looking takes radio time from WiFi, so the robot only does it:

- while it can't reach the broker: it may be on its own (there's no Pi heartbeat, so this is the only sign), and the controller is then the only way to drive it;
- for `PAD_CONNECT_WINDOW_MS` (10 s) after **Connect to RC** on the dashboard (the `connect_controller` command), in any status. Press it, then the controller's Xbox button.

Otherwise it doesn't look, so with the Pi up a controller that turns on, or drops out, stays disconnected until **Connect to RC**. It stops looking once one connects. On each connection the controller rumbles once (`PAD_RUMBLE_PCT`, `PAD_RUMBLE_MS`), and telemetry's `controller_connected` turns `true` straight away, so the dashboard shows **Controller: Connected** and confirms **Connect to RC**. The boot log says `looking for a controller (...)` and `stopped looking for a controller`; a window that finds nothing logs `connect_controller: no controller found`.

**One radio.** WiFi and Bluetooth share it, so WiFi modem sleep stays on (`comms_task`); commands from the Pi can arrive a little later than before.

`pio run -e padtest -t upload` runs the controller alone and prints its stick, buttons and link checks.

**Before the first tag.** The controller (and the dashboard's jog) drives the robot while it's `initializing` too (creeping for a tag, or after giving up), so it can be moved or bench-tested off the farm. When manual times out with no tag read, the robot stays `initializing` and halted; **A** (resume) starts the tag search again.


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
| Three blue flashes | Bluetooth controller connected |
| One long blue flash | Bluetooth controller lost |

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
- the motion hooks (`motion_test.cpp`): the drive commands they send, the ToF slow zone (manual driving included) and approaches, and each fault;
- the survival overrides (`survival_test.cpp`): each battery threshold in each status, and the obstacle events;
- the motor rules (`motor_test.cpp`): each command, the timed Drive, the reversal ramp and the safety flags;
- the controller rules (`pad_test.cpp`): the stick's deadzone, speed and drive repeat, the centre-first rule and the buttons.

## Libraries

Managed by PlatformIO in `platformio.ini`. Core libraries:

- **PubSubClient** — MQTT client
- **ArduinoJson** (v7) — JSON serialization for telemetry/commands
- **Adafruit PN532** — RFID reader
- **STM32duino VL53L4CX** — time-of-flight obstacle sensor
- **XboxSeriesXControllerESP32_asukiaaa** — Xbox controller over Bluetooth LE (brings NimBLE-Arduino)

PlatformIO downloads these automatically on first build.
