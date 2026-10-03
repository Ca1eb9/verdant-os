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
      start_driving(Phase::Driving, CRUISE_SPEED, now);
      break;
    case EdgeDrive::Backward:
      start_driving(Phase::Driving, -CRUISE_SPEED, now);
      break;
    case EdgeDrive::ElevatorForward:
    case EdgeDrive::ElevatorBackward:
      // Stay put while the elevator moves.
      send(DriveMode::Stop, 0, 0);
      phase_ = Phase::Riding;
      ride_started_ms_ = now;
      // z is the level: the wait is per level ridden.
      ride_ms_ = ELEVATOR_WAIT_MS *
                 (uint32_t)lround(fabs(GRAPH_NODES[to].z - GRAPH_NODES[from].z));
      exit_speed_ = drive == EdgeDrive::ElevatorBackward ? -CRUISE_SPEED : CRUISE_SPEED;
      break;
    case EdgeDrive::Turn:
      // Placeholder: the single-motor robot can't turn.
      send(DriveMode::Stop, 0, 0);
      phase_ = Phase::Failed;
      fault_ = "turn needed: not supported yet";
      break;
  }
}

void Motion::creep(uint32_t now) { start_driving(Phase::Creeping, CREEP_SPEED, now); }

const char* Motion::check(uint32_t now, bool blocked) {
  switch (phase_) {
    case Phase::Idle:
      return nullptr;
    case Phase::Failed:
      phase_ = Phase::Idle;
      return fault_;
    case Phase::Riding:
      if (now - ride_started_ms_ >= ride_ms_) {
        start_driving(Phase::Driving, exit_speed_, now);
      }
      return nullptr;
    case Phase::Driving:
    case Phase::Creeping: {
      if (!blocked) driven_ms_ += now - last_check_ms_;
      last_check_ms_ = now;
      bool creeping = phase_ == Phase::Creeping;
      if (driven_ms_ < (creeping ? CREEP_TIMEOUT_MS : MISSED_TAG_TIMEOUT_MS)) return nullptr;
      phase_ = Phase::Idle;
      return creeping ? "no tag found" : "missed tag";
    }
  }
  return nullptr;
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

void Motion::start_driving(Phase phase, int16_t speed, uint32_t now) {
  send(DriveMode::Drive, speed, 0);
  phase_ = phase;
  driven_ms_ = 0;
  last_check_ms_ = now;
}
