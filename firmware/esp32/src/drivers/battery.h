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

// The percentage to report: a whole number that only moves once `pct` is
// `hysteresis` past the half-way point to the next one, so a reading
// hovering on a boundary doesn't flip it back and forth (95, 96, 95...).
// `reported` is its last value, NAN before the first; a NAN `pct` keeps it.
float battery_pct_steady(float pct, float reported, float hysteresis);

#ifdef ARDUINO
class Battery {
 public:
  void begin();
  // Takes one averaged sample and updates the smoothed values, unless it's
  // under BATTERY_UNPLUGGED_V.
  void sample();
  // The last good reading, smoothed: NAN until there's been one
  float volts() const { return volts_; }
  float pct() const { return pct_; }
  // The latest sample was a real pack reading: false at BATTERY_UNPLUGGED_V
  bool ok() const { return ok_; }

 private:
  float volts_ = NAN;
  float pct_ = NAN;
  bool ok_ = false;
  bool unplugged_logged_ = false;
};
#endif
