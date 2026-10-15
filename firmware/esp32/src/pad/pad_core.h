// pad_core.h
// What the Bluetooth controller is asking for: its left stick as a drive at a
// speed, and two buttons as the stop and resume the dashboard sends
// (docs/firmware-architecture.md, "Manual control").
//
// The stick only starts driving from the centre, so a stick already pushed
// when the controller connects, after Stop, or after the link stalled can't
// move the robot. Past PAD_DEADZONE its speed runs from PAD_MIN_SPEED to
// PAD_MAX_SPEED with how far it's pushed. A held stick drives again every
// PAD_DRIVE_INTERVAL_MS, under the robot's PAD_PULSE_MS, so the robot drives
// smoothly and stops by itself when the drives stop; a change of
// PAD_SPEED_STEP or more goes out straight away.
//
// Pure C++ (no Arduino or FreeRTOS calls), so test_host can drive it.

#pragma once

#include <stdint.h>

enum class PadAction : uint8_t { None, Drive, Stop, Resume };

class PadCore {
 public:
  // The controller (re)connected, or its link stalled: forget everything.
  void reset();

  // One reading the controller is known to have just sent or confirmed.
  // `stick` is -1 (fully down) .. +1 (fully up); `stop` and `resume` are the
  // buttons, held or not.
  PadAction update(float stick, bool stop, bool resume, uint32_t now);

  // The speed of the last Drive: -255..255, backward below 0.
  int16_t speed() const { return speed_; }

 private:
  bool fresh_ = true;   // no reading since reset()
  bool armed_ = false;  // the stick has been centred
  bool stop_held_ = false;
  bool resume_held_ = false;
  int16_t speed_ = 0;   // last Drive sent; 0 when centred since
  uint32_t last_drive_ms_ = 0;
};
