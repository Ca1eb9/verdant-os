# Firmware — Robot (ESP32-S3, PlatformIO)

The robot's firmware: five FreeRTOS tasks that read the sensors, run the
robot's state machine, drive the motor, talk to the Pi over MQTT and take a
Bluetooth controller. The contract with the orchestrator is
[docs/firmware-architecture.md](../../docs/firmware-architecture.md); this page
covers how the firmware implements it and how to build and test it.

## Setup

1. Install [VS Code](https://code.visualstudio.com/).
2. Open the Extensions panel (`Cmd+Shift+X` / `Ctrl+Shift+X`), search **PlatformIO IDE** and install it.
3. Restart VS Code when prompted.
4. Open this `firmware/esp32/` folder as the project. PlatformIO finds `platformio.ini` and sets up the rest.
5. `cp src/secrets.example.h src/secrets.h` and put in the WiFi password. `secrets.h` is gitignored because the repo is public.

## Building and flashing

| Environment | What it builds |
|---|---|
| `esp32` (default) | The full firmware (`main.cpp`) |
| `bench` | The sensor and comms tasks with a stand-in nav task ([Bench test](#bench-test)) |
| `wifitest` | WiFi alone: scan, connect with failure reasons, broker check |
| `padtest` | The Xbox controller alone: pairs over Bluetooth LE and prints its stick, buttons and link checks |

Pick one with `-e <env>` or the env switcher in the bottom toolbar.

| To | Toolbar | Command |
|---|---|---|
| Build | ✓ (or `Cmd+Shift+B`) | `pio run -e esp32` |
| Upload | → | `pio run -e esp32 -t upload` |
| Serial monitor | plug icon | `pio device monitor` |

Plug into the S3 DevKit's port marked **USB** (native USB); serial output goes
there. If an upload says "Failed to connect", hold **BOOT**, tap **EN/RST**,
release **BOOT**, then upload.

## File structure

```
firmware/esp32/
├── platformio.ini          # Board, libraries, build environments
├── src/
│   ├── main.cpp            # setup(): queues + the five tasks; loop() deletes itself
│   ├── config.h            # Every pin, threshold and timing constant
│   ├── types.h             # Queue structs + shared flags: the task interfaces
│   ├── globals.cpp         # Queue handles + shared flags, create_queues()
│   ├── graph.h             # Flash graph types
│   ├── graph.cpp           # GENERATED from topology.json (tools/gen_graph.mjs)
│   ├── log.h               # LOG(tag, fmt, ...) serial logger
│   ├── secrets.example.h   # Copy to secrets.h (gitignored): WiFi password, optional broker IP and controller address
│   ├── tasks/
│   │   ├── motor_task.*        # Drive motor (highest priority)
│   │   ├── sensor_task.*       # RFID, ToF obstacle flags, battery, charge contact, AHT20
│   │   ├── nav_task.*          # Runs the state machine on the queues; status LED
│   │   ├── comms_task.*        # WiFi, MQTT pub/sub
│   │   └── pad_task.*          # Xbox controller over Bluetooth LE
│   ├── nav/
│   │   ├── nav_core.*          # Robot state machine
│   │   ├── motion.*            # Motion hooks -> DriveCommands, missed-tag faults
│   │   ├── survival.*          # Battery thresholds, motor cutoff, obstacle events
│   │   └── task_context.h      # Current/kept task, stop latch, paused status
│   ├── motor/motor_core.*      # Motor rules: timed drives, ramps, safety flags
│   ├── pad/pad_core.*          # Controller rules: stick, centre-first, buttons
│   ├── utils/nav_helpers.*     # Dijkstra, heading, turns (match navigation.ts)
│   ├── comms/comms_json.*      # JSON <-> structs, matching @farm/shared types.ts
│   ├── drivers/                # PN532 RFID, VL53L4CX ToF, battery ADC, charge contact, AHT20, motor driver
│   ├── bench/bench_main.cpp    # `bench` env
│   ├── wifitest/               # `wifitest` env
│   └── padtest/                # `padtest` env
├── tools/gen_graph.mjs     # topology.json -> src/graph.cpp
├── test_host/              # Laptop tests (see Host tests)
├── docs/state-machine.md   # Robot state machine diagrams
└── README.md
```

### What goes where

- **`config.h`**: every constant (pins, battery thresholds, timings, robot id). Nothing is hardcoded elsewhere.
- **`types.h`**: the structs that pass through the FreeRTOS queues. Every task includes it.
- **`tasks/`**: one file per FreeRTOS task. Each runs in its own loop and talks to the others only through queues and shared volatile flags, never by calling their functions. No `delay()`.
- **`main.cpp`**: creates the queues and the tasks (`xTaskCreatePinnedToCore()`), nothing else.
- **`nav/`, `motor/`, `pad/`, `utils/`, `comms/`**: logic with no Arduino or FreeRTOS calls, so `test_host/` can run it on a laptop.

## Tasks and data flow

```
sensor_task ──SensorData──▶ nav_task ──TelemetryMsg──▶ comms_task ──▶ farm/robot/{id}/telemetry
     │                         │  ──RobotEventMsg──▶              ──▶ farm/robot/{id}/events
     └─ g_obstacle_{front,rear}_flag ─▶ motor_task  ◀──Command── comms_task ◀── farm/robot/{id}/command
                                           ▲
                               pad_task ───┘ (Commands, on the same queue)
```

The motor, sensor and nav tasks run on one core; comms and pad share the
other, so a slow broker connect (up to ~3 s) never holds up the robot.

## Robot state machine

`nav/nav_core` implements the state machine in
[docs/firmware-architecture.md](../../docs/firmware-architecture.md) (diagrams:
[docs/state-machine.md](docs/state-machine.md)). The nav task feeds it tags,
battery readings, commands and the time, and it reports through a
`NavOutput`: events, and motion hooks that `nav/motion` turns into
`DriveCommand`s.

Task state is RAM only: the robot never writes to flash. A rebooted robot
starts with no task, and the orchestrator requeues it.

### Driving

The robot has one drive motor and no encoder, so it never turns. It faces
`ROBOT_HEADING`, away from the dock (so it backs onto the charger), and
`heading` never changes. `NavCore` works out how to drive each edge
(`EdgeDrive`): forward at `CRUISE_SPEED` toward the way it faces, backward
otherwise, until the next tag.

- **Elevator:** it stays put for `ELEVATOR_WAIT_MS` per level (consecutive elevator edges are one ride), then drives off the opposite way to how it drove on, to the elevator tag on the last level.
- **Turns to the side** aren't supported yet: the robot stops with a fault.
- **`creep`** drives forward at `CREEP_SPEED` until the first tag.

### ToF approach

- While driving an edge it slows to `APPROACH_SPEED` once anything ahead is inside `SLOW_ZONE_CM`. Driving by hand (a jog or the controller) does the same for the rest of its pulse, and a pulse started in the slow zone starts slow.
- After the elevator tag it creeps onto the platform until the end wall is `ELEVATOR_STOP_CM` away; `start_docking` backs onto the dock until `DOCK_STOP_CM`.
- For those two approaches it lowers that side's stop distance (`Motion::stop_cm()`, written to `g_obstacle_*_stop_cm` for the sensor task), so the obstacle flag doesn't stop it at `OBSTACLE_STOP_CM`. Each elevator and dock tag must be read while the wall is still beyond `OBSTACLE_STOP_CM`.

### Faults

The nav loop calls `Motion::check()` every cycle and passes any fault to `NavCore::fault()`:

| Fault | When |
|---|---|
| `missed tag` | `MISSED_TAG_TIMEOUT_MS` of driving with no tag. Time with the motors held off (obstacle ahead, motor cutoff) doesn't count |
| `no tag found` | `CREEP_TIMEOUT_MS` of creeping after boot (the robot stays `initializing`) |
| `couldn't get onto the elevator` / `the dock` | The end wall not reached after `APPROACH_TIMEOUT_MS` of driving |
| `can't charge: no charge contact on the dock` | At `DOCK_STOP_CM` for `CHARGE_CONTACT_TIMEOUT_MS` with the contact still open (dead charger, dirty pads). The robot can't fix this, so the orchestrator raises an alert |
| `turn needed: not supported yet` | The next node is to the side |
| `rear distance sensor not working` / `front distance sensor not working` | Creeping onto the dock or elevator for `APPROACH_TIMEOUT_MS` with that side's sensor dead |

### Survival overrides

`nav/survival` runs at the top of every nav loop, before anything else
(thresholds in `config.h`, "Survival overrides"):

| Check | What happens |
|---|---|
| Battery at or below `BATTERY_WARN_PCT` | `battery_low`, once until the next charge completes (at any level). Not while docking or charging |
| Battery at or below `BATTERY_RETURN_PCT` | `NavCore::survival_return()`: `battery_critical` and back to the dock, keeping the task. Ignored while stopped, in manual and on a dock trip. Once per drop: again only after reaching the charger or rising above `BATTERY_WARN_PCT`, so a robot that faults on the way (a dock that can't charge) stays in `error` |
| Battery at or below `BATTERY_CUTOFF_PCT` | `g_motor_kill_flag` set in every status, until the battery is back above `BATTERY_RETURN_PCT`. Whenever the robot is driving itself, `error` ("motor cutoff"), so it doesn't wait forever with the motors off. Not while charging |
| Battery reading under `BATTERY_UNPLUGGED_V` (6 V) | Not the pack: the divider wire is off, or a bench has no pack switched on. The checks above pause until a real reading is back (logged once); telemetry keeps the last good percentage (0 if there's never been one). A cutoff already in force stays |
| Obstacle flag ahead while `en_route`, `returning_to_dock` or a jog pulse in `manual` | `obstacle_detected` once, then `path_blocked` after `PATH_BLOCKED_TIMEOUT_MS`; status kept |

### Charging

While `docking` or `charging` (only then: `g_charge_sense_on`), the sensor
task reads `PIN_CHARGE_SENSE` every loop against `CHARGE_CONTACT_V` (1.8–2.3 V
docked, under 0.5 V off; [docs/wiring/robot.md](../../docs/wiring/robot.md)).
The pogo pins bounce, so the state is only known after `CHARGE_CONTACT_COUNT`
readings agree, and changes only after as many. The nav task acts on the
state, not its change:

| Contact | Status | What happens |
|---|---|---|
| Closed | `docking` | `on_charge_contact()`: brakes, `dock_connected` (and `task_complete` for a dock task), `charging` |
| Open | `charging` | `on_charge_lost()`, knocked off the charger: at or above `CHARGE_RESUME_PCT` (40%), `charge_complete` and on as after a full charge; below it, back to `docking`, backing on slowly until `DOCK_STOP_CM` |

A robot built without the docking parts never closes the contact, so a dock
trip ends in the `can't charge` fault.

While `charging`, a battery that rises less than `CHARGE_STALL_RISE_PCT`
(1 point) in `CHARGE_STALL_MS` (30 min) sends `charge_stalled` once, and the
orchestrator raises a warning. At `CHARGE_RESUME_PCT` or more the robot then
leaves the charger as if knocked off it (`charge_complete`); below it, it
stays on and keeps watching.

The `charge_complete` command (the dashboard's **Charge complete**) ends a
dock trip the same way. All of these, and reaching `CHARGE_COMPLETE_PCT`, go
through `finish_charging()`: `battery_low` and the forced return re-arm after
it, however full the battery got.

**Bench-testing the charge flow off the dock:** set `CHARGE_SENSE_ALWAYS` in `config.h`.

- The pin is read in every status, and each change is logged with its voltage (`charge contact closed (2.21 V)`).
- The contact closing while `idle`, `stopped` or `initializing` charges the robot where it is: `dock_connected`, then `charging`, with the usual `charge_complete` at `CHARGE_COMPLETE_PCT`, stall watch and **Charge complete** button. When the charge ends it goes back to `idle`, or `stopped` with its paused task. From `initializing` the tag search stops; afterwards it waits halted in `initializing` (`resume` searches again), or goes `idle` if a tag was read meanwhile.
- Only a closing contact starts a charge, so one that ended doesn't restart until the charger is unplugged and plugged in again. A full pack ends it at once (`dock_connected`, then `charge_complete`).
- Losing the contact while `charging` ends the charge (`charge_complete`) at any battery level, on the dock too: it never backs onto the dock, so unplugging the charger doesn't drive the motor.

## Motor driver

An Adafruit DRV8871 drives the motor from `PIN_MOTOR_IN1` and `PIN_MOTOR_IN2`
(GPIO 5 and 6). Wiring, power and the reasons for each part are in
[docs/wiring/robot.md](../../docs/wiring/robot.md).

| Speed | IN1 | IN2 |
|---|---|---|
| Forward | high | PWM: low for the speed's share of each cycle |
| Backward | PWM: low for the speed's share of each cycle | high |
| Stop | high | high (brake: both motor terminals shorted) |

This is the DRV8871's slow-decay mode: between pulses the motor is briefly
braked, so it gets about speed / 255 of the battery voltage. In fast decay
(the other input low instead), each off-time drives the motor's current back
against the battery, and below about half speed the motor gets nothing.

The chip's inputs have pull-downs, so the motor coasts while the ESP32 boots.
Positive speeds must drive the robot the way it faces (`ROBOT_HEADING`); if it
goes the other way, swap the motor's red and black wires.

The motor task (`tasks/motor_task`) applies `motor/motor_core` every `MOTOR_LOOP_MS`:

- The newest `DriveCommand` wins. A timed Drive (a jog pulse) ends by itself.
- Reversing slows to 0 over `REVERSE_RAMP_MS` first.
- The kill flag, or the obstacle flag on the side it's driving toward, holds the motor off until it clears.
- Every stop slows to 0 over `STOP_RAMP_MS` (a stop command, a jog pulse running out, a tag, an obstacle, the motor cutoff), so the robot doesn't jerk; once stopped, the motor is braked rather than left to coast. The robot rolls on a little while it slows, so `OBSTACLE_STOP_CM` needs to allow for it.
- Exceptions: reaching the elevator or dock wall (`ELEVATOR_STOP_CM`, `DOCK_STOP_CM`) and the dock's charge contacts touching. It's already at `APPROACH_SPEED` there, and brakes at once.

### Bench settings

These `config.h` settings are each logged at boot while off. Turn them back on before running on the farm:

| Setting | Off (`false`) |
|---|---|
| `OBSTACLE_FAILSAFE` | A missing or dead ToF sensor no longer holds the motor (no sensors plugged in) |
| `BATTERY_FAILSAFE` | No motor cutoff at low battery (battery divider not wired: it reads 0%). The low-battery warning and forced return still apply |
| `BOOT_CREEP` | After boot the robot waits in place for a tag instead of creeping forward for up to `CREEP_TIMEOUT_MS`; the controller can still drive it |

Motor check, wheels off the ground, with the serial monitor open (`motor` lines):

1. Jog forward and backward from the dashboard or the controller: the wheel turns each way and, 500 ms after the last jog (250 ms after letting go of the stick), slows to a stop. The further the stick is pushed, the faster it turns.
2. Forward then backward straight away: it slows before reversing.
3. Hand in front of the front sensor: a forward jog does nothing (`held off: obstacle`), a backward one still drives. Same at the rear, the other way round.
4. An obstacle during a reversal holds it at 0 once it has slowed down.

## Sensors

The sensor task sends `SensorData` to the nav task and sets the obstacle flags
for the motor task.

- **Tags.** The sensor task reports tag UIDs (`"0x04A1B2C3"`); the nav task maps them to node ids with the flash graph. Everything on the wire (`current_node`, event `node_id`, command `path`) is a node id, and `current_node` is `null` until the first tag.
- **New tags are signalled by `tag_seq`,** a counter in `SensorData`, not a one-shot bool. If nav falls behind and a queue entry is dropped, it still sees that the counter moved.
- **A PN532 that stops answering is re-initialised.** A reader that reset (brownout, loose cable) reads as "no tag" forever, so with no tag in the field the sensor task asks it for its firmware version every `RFID_REINIT_MS`, and runs `begin()` again if it doesn't answer.
- **Two ToF sensors, front and rear, on separate I2C buses** (`Wire` and `Wire1`), because every VL53L4CX starts at the same address. Each has its own obstacle flag; the motor task checks the one for the direction it's driving, so the robot can back away from an obstacle in front.
- **Each obstacle flag sets on the first reading under the stop distance** (`OBSTACLE_STOP_CM`) and clears only after `OBSTACLE_CLEAR_COUNT` readings over `OBSTACLE_CLEAR_CM`. When the nav task lowers a side's stop distance for an approach, the clear distance moves with it, and the change applies to the next reading.
- **A dead ToF sensor holds its flag set** (`OBSTACLE_FAILSAFE`; with it off, the flag clears instead). It's retried every `TOF_REINIT_MS`, each time restarting that sensor's I2C bus and clocking it free if the sensor is holding it stuck. A sensor that resets on its own (a dip in its supply) still answers but stops measuring, returning empty results that would read as a clear path; every real measurement advances its stream count, so the same count `TOF_STUCK_REPEATS` times in a row counts as a fault too (`stopped measuring (stream count stuck at N): restarting it`).
- **Each VL53L4CX read is one I2C transfer** (`DEFAULT_I2C_BUFFER_LEN` in `platformio.ini`, with the I2C buffers sized to match). The library splits longer reads into chunks, and its chunk loop never ends if the sensor stops answering mid-read, which would freeze the whole sensor task. A target touching a sensor reads 0 mm and still counts.
- **The charge contact is only read while docking or charging** (see [Charging](#charging)). Otherwise the sensor task skips the ADC and reports the contact as not known (`charge_sensed` false). After it turns on, `CHARGE_CONTACT_COUNT` readings in a row make it known, so a state from before a stop is never taken for the current one. A change is reported straight away, like a new tag.
- **Battery %** uses a Li-ion voltage curve rather than a straight line, because a straight line reads up to 20 points high mid-pack. Divider and calibration: [docs/battery-monitoring.md](../../docs/battery-monitoring.md).
- **Air temperature and humidity (AHT20) are for the dashboard only.** Neither the robot nor the orchestrator acts on them. The driver starts a measurement and reads it back ~80 ms later on a later loop, so it never stalls the obstacle checks, and it measures every 2 s, since measuring more often warms the chip. With no good reading for 10 s (unplugged, CRC errors), telemetry leaves `temperature_c` and `humidity_pct` out rather than repeating an old value. A missing AHT20 is retried every 5 s, and one stuck mid-measurement is reset first. The robot has no light sensor, so `light_lux` is never sent.

## Comms

- **Events go out before telemetry.** Each comms tick publishes every queued event, then queued telemetry, so a status change never reaches the Pi ahead of the event that caused it.
- **While offline, events wait in the queue** (up to `EVENT_QUEUE_LEN`) and go out in order on reconnect. Telemetry is discarded, since a stale position is useless.
- **No clock sync.** `timestamp` is the robot's uptime (`millis()`); Pi services use their own receive time.
- **No Pi heartbeat.** Losing the Pi doesn't send the robot to the dock. `g_last_command_ms` is for diagnostics only.
- **WiFi and MQTT reconnect with backoff.** While WiFi is down, the comms task scans for `WIFI_SSID` every `WIFI_RETRY_MS` and only joins once the network is found ([One radio](#one-radio) explains why).

## Bluetooth controller

An Xbox Wireless Controller (model 1914, firmware 5.x) pairs with the robot
itself over Bluetooth LE. The ESP32-S3 has no classic Bluetooth, so older
controllers and firmware won't connect.

`tasks/pad_task` turns it into commands on the same queue the dashboard's
arrive on, so the rules are the dashboard's
([firmware-architecture.md](../../docs/firmware-architecture.md#manual-control)),
with two differences:

- The stick drives at a speed rather than a fixed-speed `jog` (a robot-only `Drive` command, `NavCore::drive()`).
- It also takes over a dock trip, since its operator is at the robot. Leaving manual picks the trip back up.

| Input | Does |
|---|---|
| Left stick up / down, past `PAD_DEADZONE` | Drive forward / backward, from `PAD_MIN_SPEED` just past the deadzone to `PAD_MAX_SPEED` fully pushed. Each drive lasts `PAD_PULSE_MS` (250 ms, half a dashboard jog, so it stops sooner on release); a held stick sends another every `PAD_DRIVE_INTERVAL_MS`, or at once when the speed changes by `PAD_SPEED_STEP` |
| **B** | `stop` |
| **A** | `resume`: hand the robot back |

### Pairing

1. Turn the controller on and hold its pair button (top edge) until the Xbox light flashes fast. Until `PAD_ADDRESS` is set, the robot connects to any Xbox controller in pairing mode, and the light goes solid. After that, the Xbox button alone reconnects it.
2. **Pin it.** Copy the address from the `controller connected (...)` log line (printed on every connection) into `secrets.h` as `#define PAD_ADDRESS "44:16:22:5e:b2:d4"` and reflash. From then on only that controller can connect. If it no longer connects, check the address, or remove the line to accept any controller again. The library only pins public addresses: if the log line says the controller has a random address, pinning can't work.

A controller that was paired with a console or PC goes back to that first: turn that device's Bluetooth off.

### When it looks for a controller

Looking takes radio time from WiFi, so the robot only looks:

- while it can't reach the broker. It may be on its own (there's no Pi heartbeat, so this is the only sign), and the controller is then the only way to drive it;
- for `PAD_CONNECT_WINDOW_MS` (10 s) after **Connect to RC** on the dashboard (the `connect_controller` command), in any status. Press it, then the controller's Xbox button.

Otherwise it doesn't look, so with the Pi up, a controller that turns on or
drops out stays disconnected until **Connect to RC**. It stops looking once
one connects. The log says `looking for a controller (...)` and
`stopped looking for a controller`; a window that finds nothing logs
`no controller found`.

A controller counts as connected once it answers the robot (the robot reads
its battery level), which is about when its logo stops blinking, without
anyone touching it. Then:

- telemetry's `controller_connected` turns `true` straight away, so the dashboard shows **Controller: Connected** and confirms **Connect to RC**;
- it rumbles once, `PAD_RUMBLE_DELAY_MS` later (`PAD_RUMBLE_PCT`, `PAD_RUMBLE_MS`). If `controller connected` is logged but there's no buzz, raise `PAD_RUMBLE_DELAY_MS`;
- driving waits for its first input report, which it only sends once it's touched, so values left from an earlier connection are never acted on.

### Safety

- **The stick only starts driving from the centre.** If it's already pushed when the controller connects, after **B**, or after the link stalled, let go first.
- **Losing the controller.** A held stick sends nothing, and a dead controller takes about 3 s to show as disconnected (measured). So the task reads the controller's battery level every `PAD_LOOP_MS` and only acts on the stick after an answer. No answer, no drive: the robot stops when its last 250 ms drive pulse runs out.
- **Before the first tag.** The controller (and the dashboard's jog) drives the robot while it's `initializing` too (creeping for a tag, or after giving up), so it can be moved or bench-tested off the farm. When manual times out with no tag read, the robot stays `initializing` and halted; **A** (resume) starts the tag search again.

### One radio

WiFi and Bluetooth share the ESP32's radio, and it only runs Bluetooth with
WiFi power saving (modem sleep) on. Power saving delays messages from the Pi,
a stop included, by up to a few hundred ms. So:

- **Bluetooth only runs while it's in use:** looking for the controller, or connected to one. `PAD_RADIO_OFF_MS` (10 s) after that it turns off, and power saving with it. The log says `Bluetooth on (WiFi power saving on)` and `Bluetooth off (WiFi power saving off)`.
- **A WiFi join fails while Bluetooth shares the radio** (`AUTH_EXPIRE`), but a scan doesn't. So with WiFi down the comms task scans for `WIFI_SSID` first, and only once the network is found asks the pad task to stop Bluetooth (`g_wifi_joining`), dropping a connected controller (`WiFi network found: disconnecting the controller while WiFi joins`). It waits up to `WIFI_RADIO_FREE_MS`, joins, and hands the radio back when the join succeeds, fails or takes over `WIFI_JOIN_TIMEOUT_MS`. Afterwards the robot looks for the controller again for `PAD_CONNECT_WINDOW_MS`, broker up or not.
- **A network that isn't there** (`WiFi network 'FarmNet' not found`) never drops the controller.
- **A network that keeps refusing the robot** (wrong password, too many clients, weak signal) would drop it on every try, so after `WIFI_JOIN_FAILS_BEFORE_BACKOFF` (3) failed joins in a row a connected controller is only dropped every `WIFI_JOIN_BACKOFF_MS` (60 s) (`WiFi refused 3 times: keeping the controller...`). After a failed join the next scan waits `WIFI_RETRY_MS`, which gives Bluetooth that long to find the controller again.
- **`AUTH_EXPIRE` isn't a wrong password:** the access point didn't answer. Now and then, Bluetooth had the radio. On every try, even with Bluetooth off, the Pi still lists the robot from before a reset and ignores it ("Stale stations" in [docs/WIFI-SETUP.md](../../docs/WIFI-SETUP.md#stale-stations)).
- **`WIFI_POWER_SAVE`** in `config.h` overrides all this: `On` keeps power saving on all the time; `Off` keeps it off, and Bluetooth with it (no controller at all; **Connect to RC** is ignored).

## Status LED

The onboard NeoPixel (`PIN_STATUS_LED`, GPIO38) shows the robot's state: the
colour is the status, the animation is the detail, and short flashes show what
just happened. `show_status_led()` in `tasks/nav_task.cpp`; timings and
brightness in `config.h`.

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

## Wiring

The team's boards are **ESP32-S3-WROOM-1** DevKitC; pins are in `config.h`.
Diagrams, parts and the reasons for each resistor are in
[docs/wiring/robot.md](../../docs/wiring/robot.md).

- The front ToF is on `Wire`; the rear ToF (0x29) shares `Wire1` (GPIO 17/18) with the AHT20 (0x38). Each bus has its own clock (`I2C_FRONT_HZ`, `I2C_REAR_HZ`).
- The VL53L4CX XSHUT pins are optional: wire them to a free GPIO and set `PIN_TOF_FRONT_XSHUT` / `PIN_TOF_REAR_XSHUT`.
- **S3 pins to leave alone:** 0, 3, 45 and 46 (boot strapping); 19/20 (USB); 26–32 (flash); 33–37 (PSRAM on R8 modules); 43/44 (UART0). Only ADC1 pins (GPIO1–10) can read voltages while WiFi is on.

## Bench test

The `bench` env runs the real sensor and comms tasks with a stand-in nav task,
to test them without the rest of the robot.

1. Make `secrets.h` ([Setup](#setup)).
2. Flash: `pio run -e bench -t upload && pio device monitor -e bench`
3. Watch the broker: `mosquitto_sub -h 192.168.4.1 -t 'farm/robot/robot-1/#' -v`
4. You should see telemetry once a second. Each tag that passes the reader prints its UID on the serial monitor; copy these into `topology.json`.
5. Send a command: `mosquitto_pub -h 192.168.4.1 -t farm/robot/robot-1/command -f test_host/commands/command_0.json`. The serial monitor prints the parsed command and every waypoint.
6. Serial monitor commands: `node cp-01` sets the robot's node (the bench has no flash graph to map tags) and sends `arrived`; `status` shows link state, last command age and free stack per task.

**No hardware yet?** A bare ESP32 still works. Telemetry reports
`initializing` with `current_node: null` until `node …` sets one. With no ToF
sensors, both obstacle flags stay set, which is expected.

**Using your laptop as the broker instead of the Pi:**

- Put the laptop and ESP32 on the same 2.4 GHz network. A phone hotspot works; eduroam won't, because the ESP32 can't do WPA2-Enterprise.
- Mosquitto 2.x only listens on localhost by default. Add `listener 1883 0.0.0.0` and `allow_anonymous true` to its config.
- Set `MQTT_BROKER_IP` in `secrets.h`.

## Flash graph

`src/graph.cpp` is generated from `farm-controller/topology.json`, keeping node
and edge order exactly so on-board routes match the orchestrator's, ties
included. After changing `topology.json`:

```bash
cd firmware/esp32 && node tools/gen_graph.mjs
```

Commit both files. The host tests fail if they're out of sync.

## Host tests (no ESP32)

```bash
npm install && npm run build:shared        # once, at the repo root
cd firmware/esp32 && pio run -e bench      # once, downloads ArduinoJson
cd test_host && ./run.sh
```

Needs g++ or clang++ (on Windows, MSYS2's `mingw-w64-ucrt-x86_64-gcc`) and
Node. `run.sh` checks:

- **The contract:** the JSON the firmware sends and parses (`comms_json.cpp`) is type-checked against `RobotTelemetry`, `RobotEvent` and `RobotCommand` in `types.ts`, and every node id in it must exist in `topology.json`. Rename a field or add an enum value in `types.ts`, and this fails until `comms_json.cpp` is updated;
- the battery curve, the charge contact and the AHT20 driver's parsing;
- that `graph.cpp` matches `topology.json`, and every route, heading and turn against `navigation.ts`, on the farm and on fixtures full of equal-cost ties and elevator rides (`test_host/fixtures/`);
- the state machine (`nav_core_test.cpp`): command and sensor sequences, with every event checked to go out before its status change;
- the motion hooks (`motion_test.cpp`): the drive commands they send, the ToF slow zone (manual driving included) and approaches, and each fault;
- the survival overrides (`survival_test.cpp`): each battery threshold in each status, and the obstacle events;
- the motor rules (`motor_test.cpp`): each command, the timed Drive, the reversal ramp and the safety flags;
- the controller rules (`pad_test.cpp`): the stick's deadzone, speed and drive repeat, the centre-first rule and the buttons.

## Libraries

Managed by PlatformIO in `platformio.ini`, downloaded on the first build:

- **PubSubClient**: MQTT client
- **ArduinoJson** (v7): JSON for telemetry, events and commands
- **Adafruit PN532**: RFID reader
- **STM32duino VL53L4CX**: time-of-flight obstacle sensors
- **Adafruit NeoPixel**: status LED
- **XboxSeriesXControllerESP32_asukiaaa** and **NimBLE-Arduino**: Xbox controller over Bluetooth LE. Both are pinned, because `pad_task` uses their internals; test an update on a robot first
