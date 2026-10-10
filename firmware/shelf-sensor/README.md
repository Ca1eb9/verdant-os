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

[docs/wiring/shelf-sensor.md](../../docs/wiring/shelf-sensor.md): the
breadboard diagram, the resistors and a check for each sensor. The pins are
set in `src/config.h`; change both together.

## Output

```
# shelf-sensor boot
{"seq":0,"temperature_c":22.0,"humidity_pct":48,"light_lux":412,"water_temp_c":20.81,"water_level_ok":true,"ph_mv":2012}
# ds18b20 failed
{"seq":1,"temperature_c":22.0,"humidity_pct":48,"light_lux":410,"water_temp_c":null,"water_level_ok":true,"ph_mv":2015}
```

- Lines starting with `#` are logs. A sensor's failure and recovery are each
  logged once. The BH1750 library also prints its own `[BH1750] ERROR: ...`
  lines while that sensor is missing; the bridge treats every line that isn't
  a JSON object as a log.
- A sensor that fails to read prints `null`; the rest still report.
- `ph_mv` is the pH board's output in millivolts. The bridge converts it with
  per-shelf calibration, so recalibrating never needs a reflash.
- `seq` restarts at 0 when the board reboots (the Pi opening the port also
  resets an Uno).
- A hardware watchdog resets the board if the loop hangs for 8 s, and I2C
  calls time out instead of hanging on a stuck bus. The watchdog needs the
  Optiboot bootloader that genuine Uno R3s ship with; some clones have an
  older one that reset-loops after a watchdog reset (fix: burn the Uno
  bootloader from the Arduino IDE).
