// motor_core.h
// What the drive motor should be doing right now: the DriveCommand contract
// (types.h) as a signed speed for the motor driver.
//
// The newest command replaces the last. A timed Drive stops by itself. The
// kill flag, or the obstacle flag on the side the motor is turning toward,
// stops it for as long as the flag is set; the command carries on when the
// flag clears. Slowing to 0 takes STOP_RAMP_MS, whatever the reason, except a
// Stop with `brake`, which stops it at once. Reversing slows to 0 over
// REVERSE_RAMP_MS first.
//
// Single drive motor: left_speed and right_speed are always equal, so only
// left_speed is read. A Turn stops the motor (the robot can't turn).
//
// Pure C++ (no Arduino or FreeRTOS calls), so test_host can drive it.

#pragma once

#include <stdint.h>

#include "../types.h"

class MotorCore {
 public:
  // A command from the drive mailbox.
  void command(const DriveCommand& c, uint32_t now);

  // Every motor cycle, with the safety flags. Returns the speed for the
  // driver: -255..255, forward positive, 0 = stopped.
  int16_t update(uint32_t now, bool kill, bool obstacle_front, bool obstacle_rear);

  // seq of the last timed Drive that ran out (g_drive_done_seq). 0 = none.
  uint32_t done_seq() const { return done_seq_; }
  // A Drive is running but a flag is holding the motor off.
  bool held() const { return held_; }

 private:
  int16_t target_ = 0;   // commanded speed; 0 = stop
  int16_t output_ = 0;   // what update() last returned
  uint32_t seq_ = 0;
  uint32_t received_ms_ = 0;
  uint32_t duration_ms_ = 0;  // 0 = until replaced
  uint32_t done_seq_ = 0;
  bool held_ = false;
  // Stopping or reversing: output_ falls from ramp_from_ to 0 over ramp_ms_.
  bool ramping_ = false;
  int16_t ramp_from_ = 0;
  uint32_t ramp_ms_ = 0;
  uint32_t ramp_started_ms_ = 0;

  // Starts (or ends) a ramp for heading to `want`, if it needs one.
  void start_ramp(int16_t want, uint32_t now);
};
