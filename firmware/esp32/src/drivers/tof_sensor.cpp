// tof_sensor.cpp

#include "tof_sensor.h"

#include <Arduino.h>

#include "../config.h"
#include "../log.h"

bool TofSensor::begin() {
  if (!wire_started_) {
    bus_.begin(sda_, scl_, 400000);
    wire_started_ = true;
  }
  dev_.begin();
  dev_.VL53L4CX_Off();

  // Keep the factory address (0x52, 8-bit). The library example moves the
  // sensor to 0x12, but without XSHUT wired the sensor keeps that address
  // across an ESP32 reset, and the next boot can't find it at 0x52.
  VL53L4CX_Error st = dev_.InitSensor(VL53L4CX_DEFAULT_DEVICE_ADDRESS);
  if (st == VL53L4CX_ERROR_NONE) st = dev_.VL53L4CX_SetDistanceMode(VL53L4CX_DISTANCEMODE_SHORT);
  if (st == VL53L4CX_ERROR_NONE)
    st = dev_.VL53L4CX_SetMeasurementTimingBudgetMicroSeconds(TOF_TIMING_BUDGET_US);
  if (st == VL53L4CX_ERROR_NONE) st = dev_.VL53L4CX_StartMeasurement();

  ok_ = (st == VL53L4CX_ERROR_NONE);
  if (ok_) {
    fail_logged_ = false;
    LOG("tof", "%s VL53L4CX ready (short mode, %lu ms budget)", name_,
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

  // The sensor can report several targets. Use the nearest valid one.
  int16_t best_mm = INT16_MAX;
  for (int i = 0; i < data.NumberOfObjectsFound; i++) {
    const auto& r = data.RangeData[i];
    if (r.RangeStatus == VL53L4CX_RANGESTATUS_RANGE_VALID && r.RangeMilliMeter > 0 &&
        r.RangeMilliMeter < best_mm) {
      best_mm = r.RangeMilliMeter;
    }
  }
  if (best_mm == INT16_MAX) return TofReading::Clear;
  *cm_out = best_mm / 10.0f;
  return TofReading::Target;
}
