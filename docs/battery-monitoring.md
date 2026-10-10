# Battery monitoring — voltage divider

## Why you need it

The ESP32 ADC pins can only read about 0–3.1V (at the setting the firmware uses). Our battery is a 3S lithium pack: 12.6V at full charge, ~9.6V at empty. We need to know where in that range the battery currently sits so the robot knows when to go charge.

A buck converter steps the battery down to a constant voltage (3.3V or 5V) to power the ESP32. But "constant" is the problem — the converter outputs the same voltage whether the battery is full or nearly dead. Reading the converter's output tells you nothing about remaining charge. It reads 3.3V at 100% and still reads 3.3V one second before the battery dies.

The voltage divider taps the battery *before* the converter, where the voltage actually changes as the battery drains.

## Where it goes

```
Battery+ (12.6V) ───┬─────────────[ Buck converter ]───── ESP32 5V (power)
                     │
                     ├──[ 100kΩ ]──┬──[ 22kΩ ]──----------|
                                   │                      |
                                ESP32 GPIO4 (ADC read)    |
                                                          |
Battery- (GND) ──────┴──────────────────────────────────── ESP32 GND
```

On the robot both sit after the fuse and the power switch, and an optional 0.1 µF capacitor goes across the 22kΩ. The full wiring is in [wiring/robot.md](wiring/robot.md).

The buck converter and the voltage divider both connect to the battery, but they do completely different jobs. The converter powers the ESP32. The divider lets the ESP32 *read* the battery level. Two parallel paths from the same source.

## How it works

Two resistors in series form a voltage divider. The voltage at the midpoint between them is a fixed fraction of the input:

```
V_out = V_battery × R2 / (R1 + R2)
```

With R1 = 100kΩ and R2 = 22kΩ:

```
Full charge:  12.6V × 22/122 = 2.27V
Empty:         9.6V × 22/122 = 1.73V
```

So the ESP32's ADC reads a value between 1.73V and 2.27V, well inside the range it reads accurately (33kΩ would put a full pack at 3.13V, the edge of it). The high resistance values (100kΩ + 22kΩ) mean almost no current flows through the divider — about 0.1mA — so it doesn't meaningfully drain the battery.

## Why not just use a lower converter output?

Even if you used a 3.0V buck converter so the output fits the ADC range, it still wouldn't work. Buck converters are *regulated* — they actively maintain their target voltage regardless of input. A 3.3V converter outputs 3.3V whether the battery is at 12.6V or 10V. It only drops below 3.3V when the battery is so depleted the converter can't regulate anymore, and at that point the ESP32 is already crashing. You'd get no usable gradient, just "fine" then "dead."

## Firmware

`firmware/esp32/src/drivers/battery.cpp` reads GPIO4 (`PIN_BATTERY_ADC`), averages
`BATTERY_SAMPLES` readings, undoes the divider with `BATTERY_R1_OHMS` and
`BATTERY_R2_OHMS`, and turns each cell's voltage into a percentage with a Li-ion
discharge curve rather than a straight line (a straight line reads up to 20 points
high mid-pack). All the values are in `config.h`.

## Calibration

The ESP32's ADC isn't perfectly linear, and resistors have tolerance (±5% for standard ones). To calibrate:

1. Measure your actual resistor values with a multimeter — update `BATTERY_R1_OHMS` and `BATTERY_R2_OHMS` in `config.h` to match.
2. Measure the real battery voltage with a multimeter.
3. Compare it to the battery reading the robot reports.
4. If they differ, adjust `BATTERY_CAL_FACTOR` (the ESP32's ADC reference varies from chip to chip).

For the capstone this gets you within ±2–3%, which is plenty for knowing when to go charge.

## Parts

Two resistors, and optionally a capacitor. Use 1% tolerance if you want accuracy, 5% if you're grabbing from a kit.

| Part | Value | Purpose |
|------|-------|---------|
| R1 | 100kΩ | High-side resistor |
| R2 | 22kΩ | Low-side resistor (ADC tap) |
| C | 0.1µF | Optional. Across R2, steadies the reading |

Total cost: ~$0.10.
