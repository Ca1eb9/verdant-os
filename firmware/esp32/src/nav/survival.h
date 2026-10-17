// survival.h
// Survival overrides (docs/firmware-architecture.md): battery thresholds and
// obstacle events, whether or not the Pi is online.
//
// check() runs at the very top of every nav loop. It works through NavCore,
// which already knows when each override applies: survival_return() is
// ignored while stopped, in manual and on a dock trip, so a stop beats the
// forced return and only the motor cutoff applies to a stopped robot.
//
//   battery <= BATTERY_WARN_PCT    battery_low, once until the next charge
//                                  completes (at any level)
//   battery <= BATTERY_RETURN_PCT  survival_return(): battery_critical, dock.
//                                  Once per drop: again only after reaching
//                                  the charger or rising above
//                                  BATTERY_WARN_PCT, so a robot that faults
//                                  on the way (a dock that can't charge)
//                                  stays in error instead of retrying
//   battery <= BATTERY_CUTOFF_PCT  motors off in every status (the caller
//                                  sets g_motor_kill_flag), and fault()
//                                  whenever it's driving itself, so it
//                                  reports error instead of waiting forever.
//                                  Lifted above BATTERY_RETURN_PCT, so ADC
//                                  noise near the cutoff can't toggle the
//                                  motors.
//   blocked while driving itself   obstacle_detected once, path_blocked
//   or during a jog pulse          after PATH_BLOCKED_TIMEOUT_MS; status kept
//
// Pure C++ (no Arduino or FreeRTOS calls), so test_host can drive it.

#pragma once

#include <stdint.h>

#include "nav_core.h"

class Survival {
 public:
  explicit Survival(NavCore& core) : core_(core) {}

  // `battery_pct` is NAN until the first reading (battery checks skipped).
  // `blocked` is the obstacle flag on the side the robot drives toward.
  // Returns true while the motors must stay off.
  bool check(float battery_pct, bool blocked, uint32_t now);

 private:
  void check_battery(float battery_pct, uint32_t now);
  void check_obstacle(bool blocked, uint32_t now);

  NavCore& core_;
  bool warned_ = false;
  uint32_t charges_seen_ = 0;  // NavCore::charges_completed() last re-armed at
  bool returned_ = false;  // forced return made this drop
  bool cut_off_ = false;
  bool obstacle_reported_ = false;
  bool path_blocked_reported_ = false;
  uint32_t blocked_since_ms_ = 0;
};
