// env_sensor.cpp

#include "env_sensor.h"

// CRC-8, polynomial 0x31, init 0xFF (AHT20 datasheet).
static uint8_t crc8(const uint8_t* data, int len) {
  uint8_t crc = 0xFF;
  for (int i = 0; i < len; i++) {
    crc ^= data[i];
    for (int bit = 0; bit < 8; bit++) crc = (crc & 0x80) ? (crc << 1) ^ 0x31 : crc << 1;
  }
  return crc;
}

bool aht20_parse(const uint8_t frame[7], float* temp_c, float* humidity_pct) {
  if (frame[0] & 0x80) return false;  // busy: measurement not finished
  if (crc8(frame, 6) != frame[6]) return false;
  // 20-bit humidity, then 20-bit temperature, packed across bytes 1-5.
  uint32_t raw_rh = ((uint32_t)frame[1] << 12) | ((uint32_t)frame[2] << 4) | (frame[3] >> 4);
  uint32_t raw_t = ((uint32_t)(frame[3] & 0x0F) << 16) | ((uint32_t)frame[4] << 8) | frame[5];
  *humidity_pct = raw_rh * 100.0f / 1048576.0f;
  *temp_c = raw_t * 200.0f / 1048576.0f - 50.0f;
  return true;
}

#ifdef ARDUINO
#include <Arduino.h>

#include "../config.h"
#include "../log.h"

namespace {
constexpr uint8_t AHT20_ADDR = 0x38;
constexpr uint8_t AHT20_STATUS_CALIBRATED = 0x08;
constexpr uint8_t AHT20_STATUS_BUSY = 0x80;
constexpr uint8_t AHT20_SOFT_RESET = 0xBA;
}  // namespace

bool EnvSensor::write3(uint8_t a, uint8_t b, uint8_t c) {
  bus_.beginTransmission(AHT20_ADDR);
  bus_.write(a);
  bus_.write(b);
  bus_.write(c);
  return bus_.endTransmission() == 0;
}

void EnvSensor::fail(const char* why) {
  ok_ = false;
  measuring_ = false;
  if (!fail_logged_) {
    LOG("env", "AHT20 %s - check I2C wiring (GPIO %d/%d); retrying quietly", why,
        PIN_I2C_FRONT_SDA, PIN_I2C_FRONT_SCL);
    fail_logged_ = true;
  }
}

bool EnvSensor::begin() {
  ok_ = true;
  measuring_ = false;
  if (bus_.requestFrom(AHT20_ADDR, (uint8_t)1) != 1) {
    fail("not found");
    return false;
  }
  // Uncalibrated after some power-ups: load the factory calibration.
  if (!(bus_.read() & AHT20_STATUS_CALIBRATED) && !write3(0xBE, 0x08, 0x00)) {
    fail("init failed");
    return false;
  }
  started_ms_ = millis() - ENV_PERIOD_MS;  // first measurement on the next poll
  fail_logged_ = false;
  LOG("env", "AHT20 ready (every %lu ms)", (unsigned long)ENV_PERIOD_MS);
  return true;
}

bool EnvSensor::poll(uint32_t now, float* temp_c, float* humidity_pct) {
  if (!ok_) return false;

  if (!measuring_) {
    if (now - started_ms_ < ENV_PERIOD_MS) return false;
    if (!write3(0xAC, 0x33, 0x00)) {
      fail("stopped responding");
      return false;
    }
    measuring_ = true;
    started_ms_ = now;
    return false;
  }

  if (now - started_ms_ < ENV_MEASURE_MS) return false;
  uint8_t frame[7];
  if (bus_.requestFrom(AHT20_ADDR, (uint8_t)sizeof(frame)) != sizeof(frame)) {
    fail("stopped responding");
    return false;
  }
  for (uint8_t& b : frame) b = bus_.read();
  if (frame[0] & AHT20_STATUS_BUSY) {
    if (now - started_ms_ >= ENV_MEASURE_TIMEOUT_MS) {
      // Re-init alone doesn't clear a wedged chip. The reset takes 20 ms;
      // the caller waits ENV_REINIT_MS before begin().
      bus_.beginTransmission(AHT20_ADDR);
      bus_.write(AHT20_SOFT_RESET);
      bus_.endTransmission();
      fail("stuck measuring - reset it");
    }
    return false;  // otherwise read again next cycle
  }

  measuring_ = false;
  if (!aht20_parse(frame, temp_c, humidity_pct)) {
    if (!crc_logged_) {
      LOG("env", "AHT20 reading failed its CRC - dropped (logged once until a good one)");
      crc_logged_ = true;
    }
    return false;
  }
  crc_logged_ = false;
  return true;
}
#endif
