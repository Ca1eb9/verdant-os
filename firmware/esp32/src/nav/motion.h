// motion.h
// Turns NavCore's motion hooks into DriveCommands, and notices when a motion
// can't finish (RFID navigation).
//
// The hooks can't block: the nav loop has to keep reading tags and commands.
// So each hook only starts its motion, and check(), every nav loop, steps it
// on and reports a fault for NavCore::fault(). A tag arrival needs nothing
// here: NavCore calls follow_edge() for the next edge, which restarts the
// timer.
//
// Single drive motor, no encoder: the robot drives forward or backward until
// the next tag (EdgeDrive in nav_core.h). An edge that needs a turn faults.
//
// ToF approach: driving an edge, it slows to APPROACH_SPEED once anything
// ahead is inside SLOW_ZONE_CM (until the next edge). After the elevator or
// dock tag it creeps in until the end wall is ELEVATOR_STOP_CM / DOCK_STOP_CM
// away, lowering that side's stop distance (stop_cm()) so the obstacle flag
// doesn't stop it at OBSTACLE_STOP_CM first. Only after the tag: before it,
// anything inside OBSTACLE_STOP_CM is a real obstruction.
//
// Pure C++ (no Arduino or FreeRTOS calls), so test_host can drive it.

#pragma once

#include <stdint.h>

#include "../graph.h"
#include "../types.h"
#include "nav_core.h"

// Where DriveCommands go: the drive mailbox on the robot.
class DriveSink {
 public:
  virtual void send(const DriveCommand& c) = 0;
  virtual ~DriveSink() {}
};

class Motion {
 public:
  explicit Motion(DriveSink& sink) : sink_(sink) {}

  // Each call replaces whatever the robot was doing (NavOutput motion hooks).
  void halt();
  void jog(JogDirection direction);
  // An elevator ride first creeps onto the platform, the opposite way to the
  // way off, then waits ELEVATOR_WAIT_MS per level ridden.
  void follow_edge(NodeIndex from, NodeIndex to, EdgeDrive drive, uint32_t now);
  void creep(uint32_t now);
  // Backs onto the dock (the robot faces away from it) and stops there; the
  // charger contact is reported separately.
  void start_docking(uint32_t now);

  // Every nav loop, with the latest sensor reading. `motors_killed` is the
  // motor cutoff. Time with the motors held off (obstacle flag ahead, motor
  // cutoff) doesn't count toward the timeouts. Returns why the motion can't
  // continue, once, or nullptr.
  const char* check(uint32_t now, const SensorData& s, bool motors_killed);

  // The distance under which the sensor task should flag that side.
  float stop_cm(bool rear) const;

 private:
  enum class Phase : uint8_t { Idle, Driving, Creeping, Entering, Riding, Docking, Failed };

  void send(DriveMode mode, int16_t speed, uint32_t duration_ms);
  void start_driving(Phase phase, bool backward, int16_t speed, uint32_t now);
  bool approaching() const { return phase_ == Phase::Entering || phase_ == Phase::Docking; }

  DriveSink& sink_;
  uint32_t seq_ = 0;
  Phase phase_ = Phase::Idle;
  const char* fault_ = nullptr;  // Failed: what check() reports
  bool backward_ = false;        // the way it's driving
  bool slowed_ = false;          // Driving: in the slow zone since the edge began
  // Riding: on the elevator since, for how long, and the way off.
  uint32_t ride_started_ms_ = 0;
  uint32_t ride_ms_ = 0;
  bool exit_backward_ = false;
  // Driving/Creeping/Entering/Docking: time spent with the motors free.
  uint32_t driven_ms_ = 0;
  uint32_t last_check_ms_ = 0;
};
