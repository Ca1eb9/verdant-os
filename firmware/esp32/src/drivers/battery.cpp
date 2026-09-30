// battery.cpp

#include "battery.h"

#include <math.h>

// Typical Li-ion open-circuit voltage per cell -> state of charge.
// Must stay sorted by descending voltage.
static const float kCellCurve[][2] = {
    {4.20f, 100.0f}, {4.10f, 90.0f}, {4.00f, 80.0f}, {3.92f, 70.0f},
    {3.85f, 60.0f},  {3.79f, 50.0f}, {3.74f, 40.0f}, {3.70f, 30.0f},
    {3.65f, 20.0f},  {3.50f, 10.0f}, {3.20f, 0.0f},
};
static const int kCurvePoints = sizeof(kCellCurve) / sizeof(kCellCurve[0]);

float battery_pct_from_voltage(float pack_v, int cells) {
  if (isnan(pack_v) || cells <= 0) return NAN;
  float cell_v = pack_v / cells;
  if (cell_v >= kCellCurve[0][0]) return 100.0f;
  if (cell_v <= kCellCurve[kCurvePoints - 1][0]) return 0.0f;
  for (int i = 1; i < kCurvePoints; i++) {
    float v_hi = kCellCurve[i - 1][0], p_hi = kCellCurve[i - 1][1];
    float v_lo = kCellCurve[i][0], p_lo = kCellCurve[i][1];
    if (cell_v >= v_lo) {
      return p_lo + (cell_v - v_lo) * (p_hi - p_lo) / (v_hi - v_lo);
    }
  }
  return 0.0f;
}

#ifdef ARDUINO
#include <Arduino.h>

#include "../config.h"
#include "../log.h"

void Battery::begin() {
  analogReadResolution(12);
  analogSetPinAttenuation(PIN_BATTERY_ADC, ADC_11db);  // ~0-3.1 V input range
}

void Battery::sample() {
  // analogReadMilliVolts() applies the chip's factory ADC calibration,
  // which is more accurate than raw/4095*3.3.
  uint32_t total_mv = 0;
  for (uint8_t i = 0; i < BATTERY_SAMPLES; i++) total_mv += analogReadMilliVolts(PIN_BATTERY_ADC);
  float adc_v = (total_mv / (float)BATTERY_SAMPLES) / 1000.0f;
  float pack_v = adc_v * (BATTERY_R1_OHMS + BATTERY_R2_OHMS) / BATTERY_R2_OHMS * BATTERY_CAL_FACTOR;

  volts_ = isnan(volts_) ? pack_v : volts_ + BATTERY_EMA_ALPHA * (pack_v - volts_);
  pct_ = battery_pct_from_voltage(volts_, BATTERY_CELLS);
}
#endif
