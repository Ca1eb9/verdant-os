// motor_core.cpp
// See motor_core.h.

#include "motor_core.h"

#include "../config.h"

namespace {

constexpr int16_t MAX_SPEED = 255;

int16_t clamp_speed(int16_t speed) {
  if (speed > MAX_SPEED) return MAX_SPEED;
  if (speed < -MAX_SPEED) return -MAX_SPEED;
  return speed;
}

bool opposite(int16_t a, int16_t b) { return (a > 0 && b < 0) || (a < 0 && b > 0); }

}  // namespace

void MotorCore::command(const DriveCommand& c, uint32_t now) {
  int16_t speed = c.mode == DriveMode::Drive ? clamp_speed(c.left_speed) : 0;
  target_ = speed;
  seq_ = c.seq;
  received_ms_ = now;
  duration_ms_ = c.mode == DriveMode::Drive ? c.duration_ms : 0;

  if (opposite(output_, speed)) {
    // A second command the new way mid-ramp keeps the ramp already running.
    if (!ramping_) {
      ramping_ = true;
      ramp_from_ = output_;
      ramp_started_ms_ = now;
    }
  } else {
    // A stop, or back the way the motor is already turning: nothing to ramp.
    ramping_ = false;
  }
}

int16_t MotorCore::update(uint32_t now, bool kill, bool obstacle_front, bool obstacle_rear) {
  if (target_ != 0 && duration_ms_ != 0 && now - received_ms_ >= duration_ms_) {
    target_ = 0;
    ramping_ = false;
    done_seq_ = seq_;
  }

  int16_t out = target_;
  if (target_ != 0 && ramping_) {
    uint32_t elapsed = now - ramp_started_ms_;
    if (elapsed >= REVERSE_RAMP_MS) {
      ramping_ = false;
    } else {
      out = (int16_t)((int32_t)ramp_from_ * (int32_t)(REVERSE_RAMP_MS - elapsed) /
                      (int32_t)REVERSE_RAMP_MS);
    }
  }

  // The side the motor is turning toward: during a reversal ramp that is
  // still the old way. Never ramped: the motor stops at once.
  held_ = kill || (out > 0 && obstacle_front) || (out < 0 && obstacle_rear);
  if (held_) {
    out = 0;
    ramping_ = false;
  }
  output_ = out;
  return out;
}
