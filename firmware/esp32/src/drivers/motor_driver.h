// motor_driver.h
// The drive motor's Adafruit DRV8871: speed and direction from PWM on one of
// IN1 / IN2 while the other is low. Wiring in docs/wiring/robot.md.

#pragma once

#include <stdint.h>

// Sets up both inputs as PWM outputs with the motor braked. Call once, from
// the motor task.
void motor_driver_begin();

// -255..255. Positive drives forward, the way the robot faces (ROBOT_HEADING).
// 0 brakes (both inputs high), so a stop is a stop, not a coast.
void motor_driver_set(int16_t speed);
