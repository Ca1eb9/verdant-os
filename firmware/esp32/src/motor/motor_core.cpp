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
  if (c.mode == DriveMode::Stop && c.brake) {
    ramping_ = false;
    output_ = 0;  // stopped: update() has no ramp to start
    return;
  }
  // From receipt, so a ramp's length doesn't depend on the motor cycle.
  start_ramp(speed, now);
}

void MotorCore::start_ramp(int16_t want, uint32_t now) {
  // Back the way it was going: no need to slow down any more.
  if (ramping_ && want != 0 && !opposite(ramp_from_, want)) ramping_ = false;
  // Never down to 0 or through it at once: stopping (for any reason) takes
  // STOP_RAMP_MS, reversing REVERSE_RAMP_MS. A ramp already running carries
  // on, e.g. for a second command the new way.
  if (!ramping_ && output_ != 0 && (want == 0 || opposite(output_, want))) {
    ramping_ = true;
    ramp_from_ = output_;
    ramp_ms_ = want == 0 ? STOP_RAMP_MS : REVERSE_RAMP_MS;
    ramp_started_ms_ = now;
  }
}

int16_t MotorCore::update(uint32_t now, bool kill, bool obstacle_front, bool obstacle_rear) {
  if (target_ != 0 && duration_ms_ != 0 && now - received_ms_ >= duration_ms_) {
    target_ = 0;
    done_seq_ = seq_;
  }

  // The side the motor is turning toward (during a reversal, still the old
  // way) and the side it's commanded toward: a flag on either holds it.
  auto toward_flag = [&](int16_t speed) {
    return (speed > 0 && obstacle_front) || (speed < 0 && obstacle_rear);
  };
  bool blocked = kill || toward_flag(output_) || toward_flag(target_);
  held_ = blocked && target_ != 0;
  int16_t want = blocked ? 0 : target_;
  start_ramp(want, now);

  int16_t out = want;
  if (ramping_) {
    uint32_t elapsed = now - ramp_started_ms_;
    if (elapsed >= ramp_ms_) {
      ramping_ = false;
    } else {
      out = (int16_t)((int32_t)ramp_from_ * (int32_t)(ramp_ms_ - elapsed) / (int32_t)ramp_ms_);
    }
  }
  output_ = out;
  return out;
}
