// env_sensor.h
// AHT20 air temperature + humidity sensor (I2C, address 0x38), on the front
// ToF sensor's bus (Wire). Talks to the chip directly instead of through a
// library: the libraries wait ~80 ms for each measurement, which would stall
// the obstacle checks in the sensor loop. Here a measurement is started on
// one call and read back on a later one.

#pragma once

#include <stdint.h>

// One measurement frame: status, 5 data bytes, CRC. Pure function (no
// hardware), so it can be host-tested. False while the chip is still busy
// or when the CRC doesn't match.
bool aht20_parse(const uint8_t frame[7], float* temp_c, float* humidity_pct);

#ifdef ARDUINO
#include <Wire.h>

class EnvSensor {
 public:
  explicit EnvSensor(TwoWire& bus) : bus_(bus) {}

  // The bus must already be started (the front ToF sensor starts Wire).
  // Returns false if the chip doesn't answer.
  bool begin();
  bool ok() const { return ok_; }

  // Non-blocking. Call every sensor cycle. Starts a measurement every
  // ENV_PERIOD_MS and reads it back ENV_MEASURE_MS later. Returns true with
  // a new reading; a bus error clears ok() so the caller can re-init.
  bool poll(uint32_t now, float* temp_c, float* humidity_pct);

 private:
  bool write3(uint8_t a, uint8_t b, uint8_t c);
  void fail(const char* why);

  TwoWire& bus_;
  bool ok_ = false;
  bool measuring_ = false;
  uint32_t started_ms_ = 0;    // when the current or last measurement started
  bool fail_logged_ = false;   // log a missing sensor once, not every retry
  bool crc_logged_ = false;    // log bad frames once until a good one
};
#endif
