// tof_sensor.cpp

#include "tof_sensor.h"

#include <Arduino.h>

#include "../config.h"
#include "../log.h"

#ifndef DEFAULT_I2C_BUFFER_LEN
#error "DEFAULT_I2C_BUFFER_LEN must come from platformio.ini (the VL53L4CX read-chunk hang)"
#endif
// A transfer is the 2-byte register address plus up to this many bytes
constexpr size_t I2C_BUFFER_BYTES = DEFAULT_I2C_BUFFER_LEN + 2;

namespace {

// A sensor reset mid-transfer can hold SDA low for good, and no new
// transfer can start until it lets go: clock SCL until it does (at most 9
// bits, I2C spec 3.1.16), then send a STOP. Returns the clocks it took.
int free_bus(int sda, int scl) {
  constexpr uint32_t HALF_BIT_US = 5;  // 100 kHz
  pinMode(sda, INPUT_PULLUP);
  pinMode(scl, OUTPUT_OPEN_DRAIN);
  digitalWrite(scl, HIGH);
  delayMicroseconds(HALF_BIT_US);
  int clocks = 0;
  while (digitalRead(sda) == LOW && clocks < 9) {
    digitalWrite(scl, LOW);
    delayMicroseconds(HALF_BIT_US);
    digitalWrite(scl, HIGH);
    delayMicroseconds(HALF_BIT_US);
    clocks++;
  }
  // STOP: SDA rises while SCL is high
  pinMode(sda, OUTPUT_OPEN_DRAIN);
  digitalWrite(sda, LOW);
  delayMicroseconds(HALF_BIT_US);
  digitalWrite(scl, HIGH);
  delayMicroseconds(HALF_BIT_US);
  digitalWrite(sda, HIGH);
  delayMicroseconds(HALF_BIT_US);
  return clocks;
}

}  // namespace

bool TofSensor::begin() {
  if (wire_started_) {
    // A retry after the sensor stopped answering: restart this sensor's bus
    // (only this one), in case it or the ESP32's I2C hardware is stuck.
    bus_.end();
    int clocks = free_bus(sda_, scl_);
    if (clocks > 0) LOG("tof", "%s I2C bus was stuck: freed with %d clocks", name_, clocks);
  }
  // Before begin(): it can't resize a running bus
  if (bus_.setBufferSize(I2C_BUFFER_BYTES) != I2C_BUFFER_BYTES && !fail_logged_) {
    LOG("tof", "%s couldn't size the I2C buffer to %u bytes", name_, (unsigned)I2C_BUFFER_BYTES);
  }
  bus_.begin(sda_, scl_, hz_);
  wire_started_ = true;
  dev_.begin();
  dev_.VL53L4CX_Off();

  // Keep the factory address (0x52, 8-bit). The library example moves the
  // sensor to 0x12, but without XSHUT wired the sensor keeps that address
  // across an ESP32 reset, and the next boot can't find it at 0x52.
  VL53L4CX_Error st = dev_.InitSensor(VL53L4CX_DEFAULT_DEVICE_ADDRESS);
  // Medium, the library's default: it refuses short on a VL53L4CX (error -4,
  // invalid params).
  if (st == VL53L4CX_ERROR_NONE) st = dev_.VL53L4CX_SetDistanceMode(VL53L4CX_DISTANCEMODE_MEDIUM);
  if (st == VL53L4CX_ERROR_NONE)
    st = dev_.VL53L4CX_SetMeasurementTimingBudgetMicroSeconds(TOF_TIMING_BUDGET_US);
  if (st == VL53L4CX_ERROR_NONE) st = dev_.VL53L4CX_StartMeasurement();

  ok_ = (st == VL53L4CX_ERROR_NONE);
  if (ok_) {
    fail_logged_ = false;
    LOG("tof", "%s VL53L4CX ready (medium mode, %lu ms budget)", name_,
        (unsigned long)TOF_TIMING_BUDGET_US / 1000);
  } else if (!fail_logged_) {
    LOG("tof", "%s VL53L4CX init failed (error %d) - check I2C wiring; retrying quietly", name_, (int)st);
    fail_logged_ = true;
  }
  return ok_;
}

TofReading TofSensor::poll(float* cm_out) {
  if (!ok_) return TofReading::Error;

  uint8_t ready = 0;
  if (dev_.VL53L4CX_GetMeasurementDataReady(&ready) != VL53L4CX_ERROR_NONE) {
    ok_ = false;
    return TofReading::Error;
  }
  if (!ready) return TofReading::Pending;

  VL53L4CX_MultiRangingData_t data;
  VL53L4CX_Error st = dev_.VL53L4CX_GetMultiRangingData(&data);
  // Always re-arm, even after a bad read, or measurements stop.
  VL53L4CX_Error st2 = dev_.VL53L4CX_ClearInterruptAndStartMeasurement();
  if (st != VL53L4CX_ERROR_NONE || st2 != VL53L4CX_ERROR_NONE) {
    ok_ = false;
    return TofReading::Error;
  }

  // The sensor can report several targets. Use the nearest valid one. Also
  // valid: closer than the sensor's minimum range (clipped to it), and a
  // merged pulse (several echoes, one range). The rest (sigma, signal and
  // wraparound fails) are guesses the sensor doesn't trust.
  int16_t best_mm = INT16_MAX;
  rejected_status_ = VL53L4CX_RANGESTATUS_NONE;
  rejected_mm_ = 0;
  for (int i = 0; i < data.NumberOfObjectsFound; i++) {
    const auto& r = data.RangeData[i];
    bool valid = r.RangeStatus == VL53L4CX_RANGESTATUS_RANGE_VALID ||
                 r.RangeStatus == VL53L4CX_RANGESTATUS_RANGE_VALID_MIN_RANGE_CLIPPED ||
                 r.RangeStatus == VL53L4CX_RANGESTATUS_RANGE_VALID_MERGED_PULSE;
    // 0 mm: the library clips a target touching the sensor to 0, still valid
    if (valid && r.RangeMilliMeter >= 0 && r.RangeMilliMeter < best_mm) {
      best_mm = r.RangeMilliMeter;
    } else if (!valid && rejected_status_ == VL53L4CX_RANGESTATUS_NONE) {
      rejected_status_ = r.RangeStatus;
      rejected_mm_ = r.RangeMilliMeter;
    }
  }
  if (best_mm == INT16_MAX) return TofReading::Clear;
  *cm_out = best_mm / 10.0f;
  return TofReading::Target;
}
