# Comms + sensor tasks (Sprint 1)

Jameson's Sprint 1 deliverable: the ESP32 **communications task** and **sensor task**, plus a bench build to test them before the nav and motor tasks exist.

| File | What it does |
|---|---|
| `src/tasks/comms_task.*` | WiFi + MQTT. Publishes telemetry and events, receives commands |
| `src/comms/comms_json.*` | JSON ↔ struct conversion matching `@farm/shared` `types.ts` (pure C++, host-testable) |
| `src/tasks/sensor_task.*` | RFID position, VL53L4CX obstacle flag, battery voltage → `g_sensor_queue` |
| `src/drivers/` | `rfid_reader` (PN532), `tof_sensor` (VL53L4CX), `battery` |
| `src/types.h` | Queue structs + shared flags |
| `src/config.h` | Every pin, threshold and timing constant |
| `src/globals.cpp` | Queue handles, flags, `create_queues()` |
| `src/bench/bench_main.cpp` | Bench build: real sensor + comms tasks with a stand-in nav task |
| `test_host/` | Laptop tests: firmware JSON type-checked against the real `types.ts` |

## How data flows

```
sensor_task ──SensorData──▶ nav_task ──TelemetryMsg──▶ comms_task ──▶ farm/robot/{id}/telemetry
     │                         │  ──RobotEventMsg──▶              ──▶ farm/robot/{id}/events
     └─ g_obstacle_flag ─▶ motor_task  ◀──Command── comms_task ◀── farm/robot/{id}/command
```

The contract these follow (statuses, commands, `task_id` rules) is in
`docs/firmware-architecture.md`.

Decisions worth knowing:

- **Node ids on the wire, tag UIDs on the robot.** The sensor task reports tag UIDs (`"0x04A1B2C3"`); the nav task maps them to node ids with the flash graph. `current_node`, event `node_id` and command `path` entries are node ids, and `current_node` is `null` until the first tag.
- **New tags are signalled by `tag_seq`**, a counter in `SensorData`, not a one-shot bool. If nav falls behind and a queue entry is dropped, it still sees that the counter moved.
- **The obstacle flag sets on the first close reading** (< 15 cm) and clears only after 3 readings > 20 cm. If the ToF sensor stops responding, the flag stays set (`OBSTACLE_FAILSAFE`).
- **Events go out before telemetry.** Each comms tick publishes every queued event, then queued telemetry, so a status change never reaches the Pi ahead of the event that caused it.
- **While offline, events wait in the queue** (up to 16) and go out in order on reconnect. Telemetry is discarded, since a stale position is useless.
- **No clock sync.** `timestamp` is the robot's uptime (`millis()`); Pi services use their own receive time.
- **No Pi heartbeat.** Losing the Pi doesn't send the robot to the dock. `g_last_command_ms` is for diagnostics only.
- **No `delay()`** in either task. WiFi and MQTT reconnect with backoff. A broker connect attempt can block the comms task for ~3 s, but it runs alone on core 0 at the lowest priority.
- **Battery %** uses a Li-ion voltage curve rather than a straight line, because a straight line reads up to 20 points high mid-pack. Sprint 3 replaces the table with measurements from the real pack.

## Wiring

The team's boards are **ESP32-S3-WROOM-1** DevKitC; pins are in `config.h`.

| Part | Part pin | ESP32-S3 GPIO |
|---|---|---|
| PN532 (SPI mode: SEL0 **OFF**, SEL1 **ON**) | SCK / MISO / MOSI / SS | 12 / 13 / 11 / 10 |
| VL53L4CX | SDA / SCL | 8 / 9 |
| VL53L4CX (optional) | XSHUT | e.g. 5 → set `PIN_TOF_XSHUT` |
| Battery divider tap | 100k / 33k midpoint | 4 |
| All modules | VIN / GND | 3V3 / GND |

**S3 pins to leave alone:** 0, 3, 45 and 46 (boot strapping); 19/20 (USB); 26–32 (flash); 33–37 (PSRAM on R8 modules); 43/44 (UART0). Only ADC1 pins (GPIO1–10) can read voltages while WiFi is on. `docs/battery-monitoring.md` says GPIO34, which is a classic-ESP32 pin; on the S3 it's GPIO4.

**USB:** plug into the S3 DevKit's port marked **USB** (native USB). Serial output goes there. If an upload says "Failed to connect", hold **BOOT**, tap **EN/RST**, release **BOOT**, then upload.

> **Battery divider:** with 100k/33k, a full pack puts 3.13 V on the ADC pin. That's at the edge of what the ESP32 ADC can read, and it's inaccurate above ~2.5 V. Swapping R2 for **22k** gives 2.27 V at full and 1.73 V empty, inside the accurate range. Update `BATTERY_R2_OHMS` if you change it.

## Running the bench test

1. `cp src/secrets.example.h src/secrets.h` and put in the WiFi password. `secrets.h` is gitignored because the repo is public.
2. Flash: `pio run -e bench -t upload && pio device monitor`
3. Watch the broker: `mosquitto_sub -h 192.168.4.1 -t 'farm/robot/robot-1/#' -v`
4. You should see telemetry once a second. Each tag that passes the reader prints its UID on the serial monitor; copy these into `topology.json`.
5. Send a command:
   `mosquitto_pub -h 192.168.4.1 -t farm/robot/robot-1/command -f test_host/commands/command_0.json`
   The serial monitor prints the parsed command and every waypoint.
6. Serial monitor commands: `node cp-01` sets the robot's node (the bench has no flash graph to map tags) and sends `arrived`. `status` shows link state, last command age and free stack per task.

**No hardware yet?** A bare ESP32 still works. Telemetry reports `initializing` with `current_node: null` until `node …` sets one. The ToF fault holds the obstacle flag, which is expected.

**Testing on your laptop instead of the Pi:**

- Put the laptop and ESP32 on the same 2.4 GHz network. A phone hotspot works; eduroam won't, because the ESP32 can't do WPA2-Enterprise.
- Mosquitto 2.x only listens on localhost by default. Add `listener 1883 0.0.0.0` and `allow_anonymous true` to its config.
- Set `MQTT_BROKER_IP` in `secrets.h`.

## Host tests (no ESP32)

```bash
cd firmware/esp32 && pio run -e bench     # once, downloads ArduinoJson
cd test_host && ./run.sh
```

`run.sh` does two things:

- Compiles `comms_json.cpp` and `battery.cpp` for your laptop and runs the parse/serialise checks.
- Type-checks every JSON shape the firmware produces against `RobotTelemetry` and `RobotEvent` in `types.ts`, and the sample commands against `RobotCommand`.
- Checks that every node id in that JSON exists in `farm-controller/topology.json`.

If someone renames a field or adds an enum value in `types.ts`, the check fails until `comms_json.cpp` is updated.
