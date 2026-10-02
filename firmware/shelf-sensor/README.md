# Firmware — Shelf sensor node (Arduino Uno R3)

Reads the shelf's air and reservoir sensors and prints one JSON line every
5 s over USB serial. It has no WiFi and no clock: the Pi's `shelf-bridge`
service maps the USB port to a shelf, converts pH, stamps the receive time
and publishes `ShelfSensorData` to `farm/shelf/{id}/sensors`. Every node runs
the same build.

## Build, flash, monitor

```bash
pio run -t upload
pio device monitor
```

## Wiring

All sensors run on the Uno's 5V and GND.

| Sensor | Signal | Uno pin | Notes |
|---|---|---|---|
| DHT11 module (air temp/humidity) | S | D2 | Module has its own pull-up |
| DS18B20 probe (water temp) | yellow (data) | D3 | 4.7 kΩ from D3 to 5V |
| XKC-Y25 level sensor | yellow (out) | D4 | 10 kΩ from D4 to GND, so an unplugged sensor reads "low" |
| pH board (PH-4502C) | Po | A0 | Probe on the board's BNC socket |
| BH1750 (light) | SDA / SCL | A4 / A5 | I2C address 0x23 (ADDR low or open) |

The level sensor sticks to the outside of the reservoir at the minimum water
line; power it from 5V, not 12–24V, so its output stays safe for D4.

## Output

```
# shelf-sensor boot
{"seq":0,"temperature_c":22.0,"humidity_pct":48,"light_lux":412,"water_temp_c":20.81,"water_level_ok":true,"ph_mv":2508}
# ds18b20 failed
{"seq":1,"temperature_c":22.0,"humidity_pct":48,"light_lux":410,"water_temp_c":null,"water_level_ok":true,"ph_mv":2511}
```

- Lines starting with `#` are logs. A sensor's failure and recovery are each
  logged once.
- A sensor that fails to read prints `null`; the rest still report.
- `ph_mv` is the pH board's output in millivolts. The bridge converts it with
  per-shelf calibration, so recalibrating never needs a reflash.
- `seq` restarts at 0 when the board reboots (the Pi opening the port also
  resets an Uno).
- A hardware watchdog resets the board if the loop hangs for 8 s, and I2C
  calls time out instead of hanging on a stuck bus.
