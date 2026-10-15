// charge_contact.cpp

#include "charge_contact.h"

#include "../config.h"

void ChargeContact::update(float pin_v) {
  volts_ = pin_v;
  bool reads_closed = pin_v >= CHARGE_CONTACT_V;
  if (known_ && reads_closed == closed_) {
    count_ = 0;
    return;
  }
  if (count_ == 0 || reads_closed != pending_) {
    pending_ = reads_closed;
    count_ = 0;
  }
  if (++count_ >= CHARGE_CONTACT_COUNT) {
    closed_ = pending_;
    known_ = true;
    count_ = 0;
  }
}

void ChargeContact::reset() {
  known_ = false;
  closed_ = false;
  count_ = 0;
  volts_ = NAN;
}

#ifdef ARDUINO
#include <Arduino.h>

void ChargeContact::begin() {
  analogReadResolution(12);
  analogSetPinAttenuation(PIN_CHARGE_SENSE, ADC_11db);  // ~0-3.1 V input range
}

void ChargeContact::sample() {
  uint32_t total_mv = 0;
  for (uint8_t i = 0; i < CHARGE_SAMPLES; i++) total_mv += analogReadMilliVolts(PIN_CHARGE_SENSE);
  update((total_mv / (float)CHARGE_SAMPLES) / 1000.0f);
}
#endif
