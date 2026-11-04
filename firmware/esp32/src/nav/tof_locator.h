// tof_locator.h
// Optional ToF navigation (TOF_NAV_ENABLED, docs/tof-navigation-plan.md): a
// node reached without a tag.
//
// Every level is one straight line and the robot never turns, so the front
// sensor always sees the board at one end of its level and the rear sensor
// the board at the other. TOF_NODES has both readings with the robot on each
// node. The nav task hands what this returns to NavCore::on_tag(), so the
// robot does what that node's tag would have made it do.
//
//   check_edge()  Driving an edge: its end node, once the reading on the side
//                 it drives toward (else the other side, if the node has no
//                 reading for it) is at or past the node's for
//                 TOF_NAV_CONFIRM_COUNT fresh readings in a row. A level test,
//                 not a crossing, so a robot resumed past the node arrives.
//                 Creeping after boot: the first node on TOF_BOOT_LEVEL it's on.
//   localize()    Driven by hand (manual) or before the first node
//                 (initializing): the node it's been still on for
//                 TOF_STILL_MS, as a tag read there.
//
// What it doesn't trust, so a node is late rather than wrong (the missed-tag
// timeout then faults, as for a missed tag):
//   - a reading older than TOF_NAV_FRESH_MS (the sensor task holds one);
//   - a reading further from the last trusted one than the robot could have
//     moved (TOF_NAV_MAX_STEP_CM, plus TOF_NAV_MAX_SPEED_CM_S for time with no
//     reading at all): a hand or a leaf in the beam, or noise. After
//     TOF_NAV_RESEED_COUNT of them in a row it starts again, as at the edge's
//     start;
//   - an edge's first reading outside what lies between its two nodes (or
//     a stop's roll-on past the end one);
//   - a reading while that side's obstacle flag is set;
//   - with both boards in view, readings that don't add up to the level's
//     length (TOF_LEVEL_LENGTH_CM, else from TOF_NODES); and a node with both
//     readings is only taken with both boards in view;
//   - a reading further past the node than a stop's roll-on: the node was
//     missed (or that's something in the beam), so the edge faults.
// Toward an elevator node it reads the board behind if it can: the one ahead
// is the platform, which may be on another level.
//
// The length check only catches a sum that's short: a longer one means a
// board is missing (the platform away), and it's skipped.
// What it can't catch without the length check (TOF_LEVEL_LENGTH_CM): an
// object that stays in the beam while the robot drives up to it reads like
// the board coming closer, and can pass for the node. Measure the lengths.
// It can't tell levels apart: after an elevator ride it trusts the plan, and
// a ride cut short leaves the level unknown (level_known()) until a real tag.
//
// Pure C++ (no Arduino or FreeRTOS calls), so test_host can drive it.

#pragma once

#include <stddef.h>
#include <stdint.h>

#include "../config.h"
#include "../graph.h"
#include "../types.h"
#include "nav_core.h"

// The latest ToF readings, from SensorData.
struct TofSample {
  float front_cm;     // NAN: none
  uint32_t front_ms;  // when it was measured (tof_front_ms), 0: never
  bool front_stop;    // the front obstacle flag
  float rear_cm;
  uint32_t rear_ms;
  bool rear_stop;
};

class TofLocator {
 public:
  // `nodes`: TOF_NODES; `level_cm`: TOF_LEVEL_LENGTH_CM, by level.
  TofLocator(const TofNode* nodes, size_t node_count, const float* level_cm, size_t level_count)
      : nodes_(nodes), node_count_(node_count), level_cm_(level_cm), level_count_(level_count) {}

  // Checks the table against the graph. nullptr when it's usable; otherwise
  // why not, and every other call does nothing (tags only).
  const char* begin();
  bool ready() const { return ready_; }
  // The level it's on: TOF_BOOT_LEVEL at boot, then every node's, switched
  // when it drives off an elevator. Unknown after a ride cut short (the
  // elevator may or may not have moved): no node by ToF until a real tag.
  bool level_known() const { return level_known_; }

  // Any node reached (a real tag, or one of these): call before
  // NavCore::on_tag(), which may start the next edge.
  void on_tag(NodeIndex node);
  // The NavOutput motion hooks: follow_edge(), creep(), and every other move
  // (jog, drive, start_docking).
  void on_edge(NodeIndex from, NodeIndex to, EdgeDrive drive);
  void on_creep();
  void on_untracked_move();

  // Every nav loop with no tag read: the node reached, or NO_NODE.
  // `on_track`: Motion is driving an edge or creeping (driving_edge(),
  // creeping()); then check_edge(). Otherwise, in manual or initializing,
  // localize() on the level it's on.
  NodeIndex update(bool on_track, RobotStatus status, NodeIndex current, const TofSample& s,
                   uint32_t now);

  // The node update() just gave was refused (the encoder says the robot
  // can't be there yet): watch the same edge again from its bounds.
  void reject();

  // While Motion drives an edge (only then: not on the elevator platform) or
  // creeps: the node reached, once, or NO_NODE.
  NodeIndex check_edge(const TofSample& s, uint32_t now);
  // Manual or initializing: the node it's on, or NO_NODE. `current` is
  // NavCore's node (NO_NODE before the first), on `level`.
  NodeIndex localize(uint8_t level, NodeIndex current, const TofSample& s, uint32_t now);

 private:
  enum class Mode : uint8_t { Off, Edge, Creep };

  NodeIndex check_creep(const TofSample& s, uint32_t now);
  // The one node on `level` whose every reading is within `tol` of a fresh
  // one, or NO_NODE (none, several, or the length check fails).
  NodeIndex match(uint8_t level, const TofSample& s, uint32_t now) const;
  // A fresh reading of `node`'s more than twice TOF_LOCALIZE_TOL_CM off.
  bool clearly_off(NodeIndex node, const TofSample& s, uint32_t now) const;
  bool length_ok(uint8_t level, const TofSample& s, uint32_t now) const;
  bool past(float cm) const;
  const char* fail(const char* format, const char* id = "");
  void lose_level();

  const TofNode* nodes_;
  size_t node_count_;
  const float* level_cm_;
  size_t level_count_;
  bool ready_ = false;
  char error_[96] = "";
  // By NodeIndex, from TOF_NODES. 0: no reading for that side.
  float front_[MAX_PATH_LEN] = {};
  float rear_[MAX_PATH_LEN] = {};
  // By level: front + rear (TOF_LEVEL_LENGTH_CM, or from TOF_NODES). 0: unknown.
  float length_[MAX_PATH_LEN] = {};

  Mode mode_ = Mode::Off;
  uint8_t level_ = TOF_BOOT_LEVEL;
  bool level_known_ = true;
  // On an elevator ride (armed, not driven off yet): from and to.
  bool riding_ = false;
  NodeIndex ride_from_ = NO_NODE;
  NodeIndex ride_to_ = NO_NODE;
  // Edge: its end, which reading and its bounds, and the last trusted reading.
  NodeIndex target_ = NO_NODE;
  bool use_rear_ = false;
  bool toward_ = false;   // that side is the one it drives toward: it falls
  float target_cm_ = 0;
  float seed_lo_cm_ = 0;  // a first reading outside these isn't trusted
  float seed_hi_cm_ = 0;
  float track_cm_ = 0;    // NAN: none yet this edge
  uint32_t track_ms_ = 0; // the last reading seen, trusted or not
  uint32_t last_ms_ = 0;  // the last reading used, so each counts once
  uint8_t count_ = 0;
  uint8_t rejected_ = 0;  // readings in a row not trusted
  bool fired_ = false;
  // Creep and localize: the node it's on, and since when.
  NodeIndex candidate_ = NO_NODE;
  uint32_t candidate_ms_ = 0;
  bool away_ = false;     // localize: clearly off NavCore's node since the last arrival
  uint32_t off_since_ms_ = 0;  // localize: clearly off it since (0: isn't)
};
