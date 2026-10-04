// motion.cpp
// See motion.h.

#include "motion.h"

#include <math.h>

#include "../config.h"

void Motion::halt() {
  phase_ = Phase::Idle;
  send(DriveMode::Stop, 0, 0);
}

void Motion::jog(JogDirection direction) {
  // Timed: the motor task stops it, so there's nothing to watch.
  phase_ = Phase::Idle;
  int16_t speed = direction == JogDirection::Backward ? -JOG_SPEED : JOG_SPEED;
  send(DriveMode::Drive, speed, JOG_PULSE_MS);
}

void Motion::follow_edge(NodeIndex from, NodeIndex to, EdgeDrive drive, uint32_t now) {
  switch (drive) {
    case EdgeDrive::Forward:
    case EdgeDrive::Backward:
      start_driving(Phase::Driving, drive == EdgeDrive::Backward, CRUISE_SPEED, now);
      break;
    case EdgeDrive::ElevatorForward:
    case EdgeDrive::ElevatorBackward:
      exit_backward_ = drive == EdgeDrive::ElevatorBackward;
      // z is the level: the wait is per level ridden.
      ride_ms_ = ELEVATOR_WAIT_MS *
                 (uint32_t)lround(fabs(GRAPH_NODES[to].z - GRAPH_NODES[from].z));
      // Onto the platform first, the opposite way to the way off. Already
      // in place (e.g. resumed during the ride): it stops at once.
      start_driving(Phase::Entering, !exit_backward_, APPROACH_SPEED, now);
      break;
    case EdgeDrive::Turn:
      // Placeholder: the single-motor robot can't turn.
      send(DriveMode::Stop, 0, 0);
      phase_ = Phase::Failed;
      fault_ = "turn needed: not supported yet";
      break;
  }
}

void Motion::creep(uint32_t now) { start_driving(Phase::Creeping, false, CREEP_SPEED, now); }

void Motion::start_docking(uint32_t now) {
  start_driving(Phase::Docking, true, APPROACH_SPEED, now);
}

const char* Motion::check(uint32_t now, const SensorData& s, bool motors_killed) {
  switch (phase_) {
    case Phase::Idle:
      return nullptr;
    case Phase::Failed:
      phase_ = Phase::Idle;
      return fault_;
    case Phase::Riding:
      if (now - ride_started_ms_ >= ride_ms_) {
        start_driving(Phase::Driving, exit_backward_, CRUISE_SPEED, now);
      }
      return nullptr;
    case Phase::Driving:
    case Phase::Creeping:
    case Phase::Entering:
    case Phase::Docking:
      break;
  }

  float ahead_cm = backward_ ? s.obstacle_rear_cm : s.obstacle_front_cm;
  bool held = motors_killed || (backward_ ? s.obstacle_rear_stop : s.obstacle_front_stop);
  if (!held) driven_ms_ += now - last_check_ms_;
  last_check_ms_ = now;

  if (approaching()) {
    bool entering = phase_ == Phase::Entering;
    if (!isnan(ahead_cm) && ahead_cm <= (entering ? ELEVATOR_STOP_CM : DOCK_STOP_CM)) {
      send(DriveMode::Stop, 0, 0);
      phase_ = entering ? Phase::Riding : Phase::Idle;
      ride_started_ms_ = now;
      return nullptr;
    }
    if (driven_ms_ < APPROACH_TIMEOUT_MS) return nullptr;
    phase_ = Phase::Idle;
    return entering ? "couldn't get onto the elevator" : "couldn't get onto the dock";
  }

  if (phase_ == Phase::Driving && !slowed_ && !isnan(ahead_cm) && ahead_cm < SLOW_ZONE_CM) {
    slowed_ = true;
    send(DriveMode::Drive, backward_ ? -APPROACH_SPEED : APPROACH_SPEED, 0);
  }
  bool creeping = phase_ == Phase::Creeping;
  if (driven_ms_ < (creeping ? CREEP_TIMEOUT_MS : MISSED_TAG_TIMEOUT_MS)) return nullptr;
  phase_ = Phase::Idle;
  return creeping ? "no tag found" : "missed tag";
}

float Motion::stop_cm(bool rear) const {
  if (!approaching() || rear != backward_) return OBSTACLE_STOP_CM;
  return phase_ == Phase::Entering ? ELEVATOR_STOP_CM : DOCK_STOP_CM;
}

void Motion::send(DriveMode mode, int16_t speed, uint32_t duration_ms) {
  DriveCommand c = {};
  c.seq = ++seq_;
  c.mode = mode;
  c.left_speed = speed;
  c.right_speed = speed;
  c.duration_ms = duration_ms;
  sink_.send(c);
}

void Motion::start_driving(Phase phase, bool backward, int16_t speed, uint32_t now) {
  send(DriveMode::Drive, backward ? -speed : speed, 0);
  phase_ = phase;
  backward_ = backward;
  slowed_ = false;
  driven_ms_ = 0;
  last_check_ms_ = now;
}
