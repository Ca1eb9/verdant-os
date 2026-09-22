# Battery monitoring — voltage divider

## Why you need it

The ESP32 ADC pins can only read 0–3.3V. Our battery is a 3S lithium pack: 12.6V at full charge, ~9.6V at empty. We need to know where in that range the battery currently sits so the robot knows when to go charge.

A buck converter steps the battery down to a constant voltage (3.3V or 5V) to power the ESP32. But "constant" is the problem — the converter outputs the same voltage whether the battery is full or nearly dead. Reading the converter's output tells you nothing about remaining charge. It reads 3.3V at 100% and still reads 3.3V one second before the battery dies.

The voltage divider taps the battery *before* the converter, where the voltage actually changes as the battery drains.

## Where it goes

```
Battery+ (12.6V) ───┬─────────────[ Buck converter ]───── ESP32 VIN (power)
                     │
                     ├──[ 100kΩ ]──┬──[ 33kΩ ]──----------|
                                   │                      |
                                ESP32 GPIO34 (ADC read)   |
                                                          |
Battery- (GND) ──────┴──────────────────────────────────── ESP32 GND
```

The buck converter and the voltage divider both connect to the battery, but they do completely different jobs. The converter powers the ESP32. The divider lets the ESP32 *read* the battery level. Two parallel paths from the same source.

## How it works

Two resistors in series form a voltage divider. The voltage at the midpoint between them is a fixed fraction of the input:

```
V_out = V_battery × R2 / (R1 + R2)
```

With R1 = 100kΩ and R2 = 33kΩ:

```
Full charge:  12.6V × 33/133 = 3.13V  (under the 3.3V ADC limit)
Empty:         9.6V × 33/133 = 2.38V
```

So the ESP32's ADC reads a value between 2.38V and 3.13V, which maps linearly to 0–100% charge. The high resistance values (100kΩ + 33kΩ) mean almost no current flows through the divider — about 0.1mA — so it doesn't meaningfully drain the battery.

## Why not just use a lower converter output?

Even if you used a 3.0V buck converter so the output fits the ADC range, it still wouldn't work. Buck converters are *regulated* — they actively maintain their target voltage regardless of input. A 3.3V converter outputs 3.3V whether the battery is at 12.6V or 10V. It only drops below 3.3V when the battery is so depleted the converter can't regulate anymore, and at that point the ESP32 is already crashing. You'd get no usable gradient, just "fine" then "dead."

## Firmware

```c
#define BATTERY_ADC_PIN 34

// Resistor values (measure yours with a multimeter for accuracy)
#define R1 100000.0
#define R2  33000.0

// 3S Li-ion limits
#define VOLTAGE_FULL  12.6
#define VOLTAGE_EMPTY  9.6

float read_battery_voltage() {
    // Average multiple reads to reduce ADC noise
    int total = 0;
    for (int i = 0; i < 16; i++) {
        total += analogRead(BATTERY_ADC_PIN);
    }
    float raw = total / 16.0;

    // ESP32 ADC: 12-bit (0-4095) maps to 0-3.3V
    float adc_voltage = (raw / 4095.0) * 3.3;

    // Reverse the divider math to get actual battery voltage
    float battery_voltage = adc_voltage * (R1 + R2) / R2;

    return battery_voltage;
}

float battery_percentage() {
    float voltage = read_battery_voltage();

    // Linear mapping between empty and full
    float pct = (voltage - VOLTAGE_EMPTY) / (VOLTAGE_FULL - VOLTAGE_EMPTY) * 100.0;

    // Clamp to 0-100
    if (pct > 100.0) pct = 100.0;
    if (pct < 0.0) pct = 0.0;

    return pct;
}
```

## Calibration

The ESP32's ADC isn't perfectly linear, and resistors have tolerance (±5% for standard ones). To calibrate:

1. Measure your actual resistor values with a multimeter — update R1 and R2 in the code to match.
2. Measure the real battery voltage with a multimeter.
3. Compare to what `read_battery_voltage()` returns over serial.
4. If they differ, adjust the 3.3 multiplier slightly (the ESP32's internal reference voltage varies per chip, typically 3.0–3.3V).

For the capstone this gets you within ±2–3%, which is plenty for knowing when to go charge.

## Parts

Two resistors. Use 1% tolerance if you want accuracy, 5% if you're grabbing from a kit.

| Part | Value | Purpose |
|------|-------|---------|
| R1 | 100kΩ | High-side resistor |
| R2 | 33kΩ | Low-side resistor (ADC tap) |

Total cost: ~$0.10.
