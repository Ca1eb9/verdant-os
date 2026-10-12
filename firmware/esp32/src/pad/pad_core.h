// pad_core.h
// What the Bluetooth controller is asking for: its left stick and two
// buttons as the same jog, stop and resume the dashboard sends
// (docs/firmware-architecture.md, "Manual control").
//
// The stick only starts driving from the centre, so a stick already pushed
// when the controller connects, after Stop, or after the link stalled can't
// move the robot. A held stick repeats its jog every PAD_JOG_INTERVAL_MS,
// under the robot's JOG_PULSE_MS, so the robot drives smoothly and stops by
// itself when the jogs stop.
//
// Pure C++ (no Arduino or FreeRTOS calls), so test_host can drive it.

#pragma once

#include <stdint.h>

enum class PadAction : uint8_t { None, JogForward, JogBackward, Stop, Resume };

class PadCore {
 public:
  // The controller (re)connected, or its link stalled: forget everything.
  void reset();

  // One reading the controller is known to have just sent or confirmed.
  // `stick` is -1 (fully down) .. +1 (fully up); `stop` and `resume` are the
  // buttons, held or not.
  PadAction update(float stick, bool stop, bool resume, uint32_t now);

 private:
  enum class Direction : uint8_t { None, Forward, Backward };

  bool fresh_ = true;   // no reading since reset()
  bool armed_ = false;  // the stick has been centred
  bool stop_held_ = false;
  bool resume_held_ = false;
  Direction direction_ = Direction::None;
  uint32_t last_jog_ms_ = 0;
};
