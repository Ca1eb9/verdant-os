// tof_sensor.h
// Adafruit VL53L4CX time-of-flight distance sensor (I2C), via ST's
// "STM32duino VL53L4CX" library (works on ESP32).

#pragma once

enum class TofReading {
  Pending,   // no new measurement yet (normal; ~33 ms per measurement)
  Target,    // valid distance in *cm_out
  Clear,     // measurement finished, nothing valid in range
  Error,     // I2C / driver error
};

class TofSensor {
 public:
  bool begin();
  bool ok() const { return ok_; }

  // Non-blocking. Call every sensor cycle.
  TofReading poll(float* cm_out);

 private:
  bool ok_ = false;
};
