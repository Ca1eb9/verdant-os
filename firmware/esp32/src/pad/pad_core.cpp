// pad_core.cpp
// See pad_core.h.

#include "pad_core.h"

#include <math.h>
#include <stdlib.h>

#include "../config.h"

namespace {

// 0 inside the deadzone.
int16_t stick_speed(float stick) {
  float travel = fabsf(stick);
  if (travel <= PAD_DEADZONE) return 0;
  float share = fminf((travel - PAD_DEADZONE) / (1.0f - PAD_DEADZONE), 1.0f);
  int16_t speed = (int16_t)lroundf(PAD_MIN_SPEED + share * (PAD_MAX_SPEED - PAD_MIN_SPEED));
  return stick > 0 ? speed : -speed;
}

}  // namespace

void PadCore::reset() {
  fresh_ = true;
  armed_ = false;
  speed_ = 0;
}

PadAction PadCore::update(float stick, bool stop, bool resume, uint32_t now) {
  // A button already down at the first reading isn't a press.
  bool stop_pressed = stop && !stop_held_ && !fresh_;
  bool resume_pressed = resume && !resume_held_ && !fresh_;
  stop_held_ = stop;
  resume_held_ = resume;
  fresh_ = false;

  int16_t speed = stick_speed(stick);
  if (speed == 0) armed_ = true;

  if (stop_pressed) {
    armed_ = false;
    speed_ = 0;
    return PadAction::Stop;
  }

  if (!armed_ || speed == 0) {
    speed_ = 0;
  } else {
    // Starting, or the other way: at once, not after the interval.
    bool turned = (speed > 0) != (speed_ > 0) || speed_ == 0;
    if (turned || abs(speed - speed_) >= PAD_SPEED_STEP ||
        now - last_drive_ms_ >= PAD_DRIVE_INTERVAL_MS) {
      speed_ = speed;
      last_drive_ms_ = now;
      return PadAction::Drive;
    }
  }
  // After the drive, so letting go of the stick onto Resume can't be missed.
  return resume_pressed ? PadAction::Resume : PadAction::None;
}
