# Comms + sensor tasks (Sprint 1)

Jameson's Sprint 1 deliverable: the ESP32 **communications task** and **sensor task**, plus a bench build to test them before the nav and motor tasks exist.

| File | What it does |
|---|---|
| `src/tasks/comms_task.*` | WiFi + MQTT. Publishes telemetry and events, receives commands, tracks the Pi heartbeat |
| `src/comms/comms_json.*` | JSON ↔ struct conversion matching `@farm/shared` `types.ts` (pure C++, host-testable) |
| `src/tasks/sensor_task.*` | RFID position, VL53L4CX obstacle flag, battery voltage → `g_sensor_queue` |
| `src/drivers/` | `rfid_reader` (PN532 or RC522), `tof_sensor` (VL53L4CX), `battery` |
| `src/types.h` | Queue structs + shared flags (**proposal for Caleb**, see below) |
| `src/config.h` | Every pin, threshold and timing constant |
| `src/globals.cpp` | Queue handles, flags, `create_queues()` |
| `src/bench/bench_main.cpp` | Bench build: real sensor + comms tasks with a stand-in nav task |
| `test_host/` | Laptop tests: firmware JSON type-checked against the real `types.ts` |

## How data flows

```
sensor_task ──SensorData──▶ nav_task ──TelemetryMsg──▶ comms_task ──▶ farm/robot/{id}/telemetry
     │                         │  ──RobotEventMsg──▶              ──▶ farm/robot/{id}/events
     └─ g_obstacle_flag ─▶ motor_task  ◀──Command── comms_task ◀── farm/robot/{id}/command
                                        g_last_pi_msg_ms ◀────── farm/system/orchestrator/heartbeat
```

Decisions worth knowing:

- **Tag IDs everywhere.** `current_node` in telemetry and every entry in a command's `path` is an RFID tag ID (`"0x04A1B2C3"`), the same as the simulator. Tags are normalised to `0x` + uppercase hex so the nav task can compare with `strcmp`.
- **New tags are signalled by `tag_seq`**, a counter in `SensorData`, not a one-shot bool. If nav falls behind and a queue entry is dropped, it still sees that the counter moved.
- **The obstacle flag sets on the first close reading** (< 15 cm) and clears only after 3 readings > 20 cm. If the ToF sensor stops responding, the flag stays set (`OBSTACLE_FAILSAFE`).
- **While offline, events wait in the queue** (up to 16) and go out in order on reconnect. Telemetry is discarded, since a stale position is useless.
- **No `delay()`** in either task. WiFi and MQTT reconnect with backoff. A broker connect attempt can block the comms task for ~3 s, but it runs alone on core 0 at the lowest priority.
- **Battery %** uses a Li-ion voltage curve rather than a straight line, because a straight line reads up to 20 points high mid-pack. Sprint 3 replaces the table with measurements from the real pack.

## Wiring

The team's boards are **ESP32-S3-WROOM-1** DevKitC. `platformio.ini` targets the S3, and `config.h` picks the pin set for whichever chip is built (the classic ESP32 set is kept in case a different board is used).

| Part | Part pin | ESP32-S3 GPIO | (classic ESP32) |
|---|---|---|---|
| PN532 (SPI mode: SEL0 **OFF**, SEL1 **ON**) | SCK / MISO / MOSI / SS | 12 / 13 / 11 / 10 | 18 / 19 / 23 / 5 |
| RC522 (if used instead) | + RST | 14 | 27 |
| VL53L4CX | SDA / SCL | 8 / 9 | 21 / 22 |
| VL53L4CX (optional) | XSHUT | e.g. 5 → set `PIN_TOF_XSHUT` | |
| Battery divider tap | 100k / 33k midpoint | 4 | 34 |
| All modules | VIN / GND | 3V3 / GND | |

To switch RFID modules, add `-DRFID_READER_RC522` to `build_flags` in `platformio.ini`. PN532 is the default.

**S3 pins to leave alone:** 0, 3, 45 and 46 (boot strapping); 19/20 (USB); 26–32 (flash); 33–37 (PSRAM on R8 modules); 43/44 (UART0). Only ADC1 pins (GPIO1–10) can read voltages while WiFi is on. `docs/battery-monitoring.md` says GPIO34, which only applies to the classic ESP32; on the S3 it's GPIO4.

**USB:** plug into the S3 DevKit's port marked **USB** (native USB). Serial output goes there. If an upload says "Failed to connect", hold **BOOT**, tap **EN/RST**, release **BOOT**, then upload.

> **Battery divider:** with 100k/33k, a full pack puts 3.13 V on the ADC pin. That's at the edge of what the ESP32 ADC can read, and it's inaccurate above ~2.5 V. Swapping R2 for **22k** gives 2.27 V at full and 1.73 V empty, inside the accurate range. Update `BATTERY_R2_OHMS` if you change it.

## Running the bench test

1. `cp src/secrets.example.h src/secrets.h` and put in the WiFi password. `secrets.h` is gitignored because the repo is public.
2. Flash: `pio run -e bench -t upload && pio device monitor`
3. Watch the broker: `mosquitto_sub -h 192.168.4.1 -t 'farm/robot/robot-1/#' -v`
4. You should see telemetry once a second, and an `arrived` event each time a tag passes the reader.
5. Send a command:
   `mosquitto_pub -h 192.168.4.1 -t farm/robot/robot-1/command -f test_host/commands/command_0.json`
   The serial monitor prints the parsed command and every waypoint.
6. Serial monitor commands: `tag 0x2A01` fakes a tag read (no reader needed). `status` shows link state, heartbeat age and free stack per task.

**No hardware yet?** A bare ESP32 still works. Telemetry publishes with `current_node: ""`, and `tag …` fakes positions. The ToF fault holds the obstacle flag, which is expected.

**Testing on your laptop instead of the Pi:**

- Put the laptop and ESP32 on the same 2.4 GHz network. A phone hotspot works; eduroam won't, because the ESP32 can't do WPA2-Enterprise.
- Mosquitto 2.x only listens on localhost by default. Add `listener 1883 0.0.0.0` and `allow_anonymous true` to its config.
- Set `MQTT_BROKER_IP` and `NTP_SERVER "pool.ntp.org"` in `secrets.h`.

## Host tests (no ESP32)

```bash
cd firmware/esp32 && pio run -e bench     # once, downloads ArduinoJson
cd test_host && ./run.sh
```

`run.sh` does two things:

- Compiles `comms_json.cpp` and `battery.cpp` for your laptop and runs the parse/serialise checks.
- Type-checks every JSON shape the firmware produces against `RobotTelemetry` and `RobotEvent` in `types.ts`, and the sample commands against `RobotCommand`.

If someone renames a field or adds an enum value in `types.ts`, the check fails until `comms_json.cpp` is updated.

## Needs from the rest of the team

1. **Caleb: `types.h`.** It was empty, so this is a proposal the comms and sensor tasks code against. Change it freely, but keep `comms_json.cpp` in sync (`test_host/run.sh` will tell you).
2. **Caleb: the ingester drops every real robot telemetry row.** The `robot_telemetry` table declares `temperature_c`, `humidity_pct` and `light_lux` as `NOT NULL`, but they're optional in `RobotTelemetry`, and the robot has none of those sensors. The simulator always sends them, which is why this hasn't shown up. The insert fails, the MQTT wrapper logs "Handler error", and the row is lost. Fix: drop `NOT NULL` on those three columns and delete the old `farm_telemetry.db`, since `CREATE TABLE IF NOT EXISTS` won't alter an existing table.
3. **Caleb: the orchestrator heartbeat.** The robot's Pi watchdog resets on any command *or* a message on `farm/system/orchestrator/heartbeat`. The orchestrator needs to publish there every few seconds, or an idle robot will decide the Pi is gone and drive to the dock.
4. **Pi: NTP for FarmNet.** FarmNet has no internet, so the ESP32 syncs its clock from the Pi. Without that, `timestamp` is sent as `0` and Pi services should use their receive time. On the Pi:
   ```bash
   sudo apt install chrony
   echo -e "allow 192.168.4.0/24\nlocal stratum 10" | sudo tee -a /etc/chrony/chrony.conf
   sudo systemctl restart chrony
   ```
5. **`topology.json` tag IDs are placeholders.** Real UIDs are 4 or 7 bytes (`0x04A1B2C3`), not `0x2A01`. Once tags arrive, run the bench build, pass each tag over the reader, and copy the printed UID into `topology.json`. Also, `water-11` reuses `water-01`'s tag `0x3C10` and `z: 0`, so a tag lookup always returns `water-01`.
6. **The boards are ESP32-S3, not classic ESP32.** `platformio.ini` originally targeted `esp32dev`, which can't flash an S3, and several classic-ESP32 pins break on the S3: 22 and 23 don't exist, 19 is a USB data line, 27 is a flash pin, and 34 is a PSRAM pin with no ADC. It's now set to `esp32-s3-devkitc-1`; Caleb's nav and motor code should take pins from `config.h`.
7. **RFID module.** The timeline says RC522, but `platformio.ini` was set up with the PN532. Both are supported; confirm which one is being bought.
