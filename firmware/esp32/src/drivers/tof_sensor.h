// tof_sensor.h
// Adafruit VL53L4CX time-of-flight distance sensor (I2C), via ST's
// "STM32duino VL53L4CX" library (works on ESP32). One object per sensor.

#pragma once

#include <Wire.h>
#include <vl53l4cx_class.h>

enum class TofReading {
  Pending,   // no new measurement yet (normal; ~33 ms per measurement)
  Target,    // valid distance in *cm_out
  Clear,     // measurement finished, nothing valid in range
  Error,     // I2C / driver error
};

class TofSensor {
 public:
  // `name` is for logs ("front", "rear"). Every VL53L4CX starts at the same
  // address, so each sensor needs its own I2C bus.
  TofSensor(const char* name, TwoWire& bus, int sda, int scl, int xshut)
      : name_(name), bus_(bus), sda_(sda), scl_(scl), dev_(&bus, xshut) {}

  bool begin();
  bool ok() const { return ok_; }
  const char* name() const { return name_; }

  // Non-blocking. Call every sensor cycle.
  TofReading poll(float* cm_out);

 private:
  const char* name_;
  TwoWire& bus_;
  int sda_;
  int scl_;
  VL53L4CX dev_;
  bool ok_ = false;
  bool wire_started_ = false;
  bool fail_logged_ = false;  // log a missing sensor once, not every retry
};
