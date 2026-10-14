// motor_driver.cpp
// See motor_driver.h.

#include "motor_driver.h"

#include <Arduino.h>

#include "../config.h"

namespace {

// ledcWrite() turns the maximum into 100% duty (it writes 2^bits), so this
// holds a pin fully high: speed 255 and the brake are steady, not PWMed.
constexpr uint32_t FULL_DUTY = (1u << MOTOR_PWM_BITS) - 1;

// The LEDC calls changed in arduino-esp32 3.x: PWM is addressed by pin there,
// by channel before.
void pwm_begin(int pin, uint8_t channel) {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  (void)channel;
  ledcAttach(pin, MOTOR_PWM_HZ, MOTOR_PWM_BITS);
#else
  ledcSetup(channel, MOTOR_PWM_HZ, MOTOR_PWM_BITS);
  ledcAttachPin(pin, channel);
#endif
}

void pwm_write(int pin, uint8_t channel, uint32_t duty) {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  (void)channel;
  ledcWrite(pin, duty);
#else
  (void)pin;
  ledcWrite(channel, duty);
#endif
}

void set_inputs(uint32_t in1_duty, uint32_t in2_duty) {
  pwm_write(PIN_MOTOR_IN1, MOTOR_PWM_CHANNEL_IN1, in1_duty);
  pwm_write(PIN_MOTOR_IN2, MOTOR_PWM_CHANNEL_IN2, in2_duty);
}

}  // namespace

void motor_driver_begin() {
  pwm_begin(PIN_MOTOR_IN1, MOTOR_PWM_CHANNEL_IN1);
  pwm_begin(PIN_MOTOR_IN2, MOTOR_PWM_CHANNEL_IN2);
  motor_driver_set(0);
}

void motor_driver_set(int16_t speed) {
  if (speed == 0) {
    set_inputs(FULL_DUTY, FULL_DUTY);  // brake
    return;
  }
  uint32_t magnitude = (uint32_t)(speed > 0 ? speed : -speed);
  if (magnitude > 255) magnitude = 255;
  uint32_t duty = magnitude * FULL_DUTY / 255;
  // Slow decay: one input held high, the other low for `duty` of each cycle
  // and high (brake) for the rest. The motor gets about duty x the battery.
  // With the other input low instead (fast decay), each off-time drives the
  // current back against the battery, and below about half duty the motor
  // gets nothing. The held input goes high first, so the bridge never sees
  // both PWMed at once.
  if (speed > 0) {
    pwm_write(PIN_MOTOR_IN1, MOTOR_PWM_CHANNEL_IN1, FULL_DUTY);
    pwm_write(PIN_MOTOR_IN2, MOTOR_PWM_CHANNEL_IN2, FULL_DUTY - duty);
  } else {
    pwm_write(PIN_MOTOR_IN2, MOTOR_PWM_CHANNEL_IN2, FULL_DUTY);
    pwm_write(PIN_MOTOR_IN1, MOTOR_PWM_CHANNEL_IN1, FULL_DUTY - duty);
  }
}
