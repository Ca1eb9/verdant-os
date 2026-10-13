// pad_core.cpp
// See pad_core.h.

#include "pad_core.h"

#include "../config.h"

void PadCore::reset() {
  fresh_ = true;
  armed_ = false;
  direction_ = Direction::None;
}

PadAction PadCore::update(float stick, bool stop, bool resume, uint32_t now) {
  // A button already down at the first reading isn't a press.
  bool stop_pressed = stop && !stop_held_ && !fresh_;
  bool resume_pressed = resume && !resume_held_ && !fresh_;
  stop_held_ = stop;
  resume_held_ = resume;
  fresh_ = false;

  bool centred = stick <= PAD_DEADZONE && stick >= -PAD_DEADZONE;
  if (centred) armed_ = true;

  if (stop_pressed) {
    armed_ = false;
    direction_ = Direction::None;
    return PadAction::Stop;
  }

  Direction direction = centred || !armed_ ? Direction::None
                        : stick > 0        ? Direction::Forward
                                           : Direction::Backward;
  bool changed = direction != direction_;
  direction_ = direction;
  if (direction != Direction::None && (changed || now - last_jog_ms_ >= PAD_JOG_INTERVAL_MS)) {
    last_jog_ms_ = now;
    return direction == Direction::Forward ? PadAction::JogForward : PadAction::JogBackward;
  }
  // After the drive, so letting go of the stick onto Resume can't be missed.
  return resume_pressed ? PadAction::Resume : PadAction::None;
}
