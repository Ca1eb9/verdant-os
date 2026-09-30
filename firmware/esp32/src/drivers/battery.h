// battery.h
// Pack voltage through the R1/R2 divider on PIN_BATTERY_ADC
// (docs/battery-monitoring.md), smoothed, and converted to a percentage.

#pragma once

#include <math.h>

// Percentage from pack voltage, using a typical Li-ion resting-voltage curve.
// Pure function (no hardware), so it can be host-tested. Li-ion voltage is
// not linear in charge: a straight line from 9.6 V to 12.6 V reads up to
// 20 points too high in the middle of the pack.
// Sprint 3: replace the table with one measured on the real pack.
float battery_pct_from_voltage(float pack_v, int cells);

#ifdef ARDUINO
class Battery {
 public:
  void begin();
  // Takes one averaged sample and updates the smoothed values.
  void sample();
  float volts() const { return volts_; }  // NAN until first sample
  float pct() const { return pct_; }      // NAN until first sample

 private:
  float volts_ = NAN;
  float pct_ = NAN;
};
#endif
