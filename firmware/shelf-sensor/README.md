# Firmware — Shelf sensor node (Arduino Uno R3)

Reads the shelf's air and reservoir sensors and prints one JSON line every
5 s over USB serial. It has no WiFi and no clock: the Pi's `shelf-bridge`
service maps the USB port to a shelf, converts pH, stamps the receive time
and publishes `ShelfSensorData` to `farm/shelf/{id}/sensors`. It also drives
two relays that switch the level grow lights, when the bridge tells it to
(see Input). Every node runs the same build.

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
- `# lights 10` is logged when the level lights change (see Input).
- A hardware watchdog resets the board if the loop hangs for 8 s, and I2C
  calls time out instead of hanging on a stuck bus. The watchdog needs the
  Optiboot bootloader that genuine Uno R3s ship with; some clones have an
  older one that reset-loops after a watchdog reset (fix: burn the Uno
  bootloader from the Arduino IDE).

## Input

The bridge sends one line to switch the level light relays
(`PIN_LIGHT_RELAY` in `src/config.h`: D5 is channel 0, D6 channel 1):

```
lights 10
```

One `1` (light on) or `0` (light off) per channel, from channel 0. A channel
missing from the end of the line stays on. Anything else is logged as
`# bad input: ...` and changes nothing.

- **Lights start on.** At boot, and whenever the board resets, the relays are
  released and every light is at full brightness, the same as with the Uno
  unpowered. The bridge sends the real state as soon as the board prints, and
  again with every reading.
- **No line from the Pi for 30 s** (`LIGHTS_TIMEOUT_MS`), after it has sent
  one: every light goes back on, and it logs
  `# no lights line from the Pi, all lights on`. That covers a bridge that
  stopped without the board resetting.
- An energised relay shorts that light's 0–10 V dim wires, which turns it off
  (`LIGHT_OFF_RELAY_STATE`). Wiring:
  [docs/wiring/shelf-sensor.md](../../docs/wiring/shelf-sensor.md#level-light-relays).

To try it by hand, stop the bridge and type `lights 01` in
`pio device monitor`: the D5 relay clicks on (its light off) and the board
logs `# lights 01`. After 30 s it logs the timeout and both lights are on again.
