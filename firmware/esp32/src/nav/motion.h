// motion.h
// Turns NavCore's motion hooks into DriveCommands, and notices when a motion
// can't finish (RFID navigation).
//
// The hooks can't block: the nav loop has to keep reading tags and commands.
// So each hook only starts its motion, and check(), every nav loop, steps it
// on (an elevator wait, then the drive off) and reports a fault for
// NavCore::fault(). A tag arrival needs nothing here: NavCore calls
// follow_edge() for the next edge, which restarts the timer.
//
// Single drive motor, no encoder: the robot drives forward or backward until
// the next tag (EdgeDrive in nav_core.h). An edge that needs a turn faults.
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
  void follow_edge(NodeIndex from, NodeIndex to, EdgeDrive drive, uint32_t now);
  void creep(uint32_t now);

  // Every nav loop. `blocked` is true while the motor task holds the motors
  // off (obstacle ahead, motor cutoff): that time doesn't count toward the
  // timeouts. Returns why the motion can't continue, once, or nullptr.
  const char* check(uint32_t now, bool blocked);

 private:
  enum class Phase : uint8_t { Idle, Riding, Driving, Creeping, Failed };

  void send(DriveMode mode, int16_t speed, uint32_t duration_ms);
  void start_driving(Phase phase, int16_t speed, uint32_t now);

  DriveSink& sink_;
  uint32_t seq_ = 0;
  Phase phase_ = Phase::Idle;
  const char* fault_ = nullptr;  // Failed: what check() reports
  // Riding: on the elevator since, for how long, and the speed to drive off at.
  uint32_t ride_started_ms_ = 0;
  uint32_t ride_ms_ = 0;
  int16_t exit_speed_ = 0;
  // Driving/Creeping: time spent unblocked.
  uint32_t driven_ms_ = 0;
  uint32_t last_check_ms_ = 0;
};
