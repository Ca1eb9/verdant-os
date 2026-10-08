// survival.cpp
// See survival.h.

#include "survival.h"

#include <math.h>
#include <stdio.h>

#include "../config.h"

bool Survival::check(float battery_pct, bool blocked, uint32_t now) {
  if (!isnan(battery_pct)) check_battery(battery_pct, now);
  check_obstacle(blocked, now);
  return cut_off_;
}

void Survival::check_battery(float battery_pct, uint32_t now) {
  char details[EVENT_DETAILS_LEN];
  snprintf(details, sizeof(details), "%.1f%%", battery_pct);
  RobotStatus status = core_.status();

  if (battery_pct >= CHARGE_COMPLETE_PCT) warned_ = false;
  if (cut_off_ && battery_pct > BATTERY_RETURN_PCT) cut_off_ = false;

  // Charging (or on its way to the charger) is the fix, not a warning.
  bool charging = status == RobotStatus::Docking || status == RobotStatus::Charging;
  if (!warned_ && !charging && battery_pct <= BATTERY_WARN_PCT) {
    warned_ = true;
    core_.report(RobotEventType::BatteryLow, details);
  }

  bool newly_cut_off = !cut_off_ && battery_pct <= BATTERY_CUTOFF_PCT;
  if (newly_cut_off) cut_off_ = true;
  // Whenever it tries to drive itself (e.g. resumed after a stop), not just
  // once: otherwise it waits forever with the motors off. Initializing never
  // changes status on a fault, so that's only reported once.
  bool driving = status == RobotStatus::EnRoute || status == RobotStatus::ReturningToDock ||
                 status == RobotStatus::Docking;
  if (cut_off_ && (driving || (newly_cut_off && status == RobotStatus::Initializing))) {
    char why[EVENT_DETAILS_LEN];
    snprintf(why, sizeof(why), "motor cutoff at %s", details);
    core_.fault(why);
  }
  // Can't drive anywhere with the motors off.
  if (!cut_off_ && battery_pct <= BATTERY_RETURN_PCT) core_.survival_return(details, now);
}

void Survival::check_obstacle(bool blocked, uint32_t now) {
  // While driving on its own, and during a jog pulse: the operator may not
  // have seen the obstacle, so tell them why it stopped.
  RobotStatus status = core_.status();
  bool jogging = status == RobotStatus::Manual &&
                 now - core_.last_manual_input_ms() < JOG_PULSE_MS;
  bool driving =
      status == RobotStatus::EnRoute || status == RobotStatus::ReturningToDock || jogging;
  if (!blocked || !driving) {
    obstacle_reported_ = false;
    path_blocked_reported_ = false;
    return;
  }
  if (!obstacle_reported_) {
    obstacle_reported_ = true;
    blocked_since_ms_ = now;
    core_.report(RobotEventType::ObstacleDetected, "");
  } else if (!path_blocked_reported_ && now - blocked_since_ms_ >= PATH_BLOCKED_TIMEOUT_MS) {
    path_blocked_reported_ = true;
    core_.report(RobotEventType::PathBlocked, "");
  }
}
