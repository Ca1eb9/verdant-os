// battery.h
// Pack voltage through the R1/R2 divider on PIN_BATTERY_ADC
// (docs/battery-monitoring.md), smoothed, and converted to a percentage.

#pragma once

#include <math.h>

// Percentage from pack voltage, using a typical Li-ion resting-voltage curve,
// stretched so `full_pack_v` reads 100% (a pack that charges a little above
// 4.2 V a cell); empty stays at 3.2 V a cell. NAN for a `full_pack_v` at or
// below empty. Pure function (no hardware), so it can be host-tested. Li-ion
// voltage is not linear in charge: a straight line from empty to full reads up
// to 20 points too high in the middle of the pack.
// Sprint 3: replace the table with one measured on the real pack.
float battery_pct_from_voltage(float pack_v, int cells, float full_pack_v);

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
