// charge_contact.h
// The dock's charge contact: pad + through the divider on PIN_CHARGE_SENSE
// (docs/wiring/robot.md), against CHARGE_CONTACT_V.

#pragma once

#include <math.h>
#include <stdint.h>

class ChargeContact {
 public:
  // One reading of the pin, in volts. Pure (no hardware), so it can be
  // host-tested. The state is known after CHARGE_CONTACT_COUNT readings in a
  // row on one side of the threshold, and changes only after as many on the
  // other side: the pogo pins bounce as the robot backs on.
  void update(float pin_v);
  // Not known again. While nav isn't docking or charging the pin isn't read,
  // so a state from before can't be taken for the current one.
  void reset();
  bool known() const { return known_; }
  bool closed() const { return known_ && closed_; }
  float volts() const { return volts_; }  // last reading, NAN until one

#ifdef ARDUINO
  void begin();
  // Reads the pin (CHARGE_SAMPLES averaged) and calls update().
  void sample();
#endif

 private:
  bool known_ = false;
  bool closed_ = false;
  bool pending_ = false;  // the state the last `count_` readings agree on
  uint8_t count_ = 0;
  float volts_ = NAN;
};
