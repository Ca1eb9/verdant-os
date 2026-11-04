// confirm_nav.h
// Optional confirmed navigation (CONFIRM_NAV_ENABLED,
// docs/confirm-navigation-plan.md): the operator says when the robot reaches
// each node.
//
// node_reached carries no node. It means "the node you were driving to is
// reached": the end of the last edge Motion drove. The nav task hands it to
// NavCore::on_tag() as if that node's tag were read, so the robot does what
// the tag would have made it do: arrive, drive the next edge, start the
// elevator or dock approach, or recover from an error. Accepted:
//   - initializing (no node yet): the dock, where the robot is set down;
//   - en_route or returning_to_dock: the end of the edge it's driving. An
//     elevator ride's end only once it's driving off the platform: during
//     the ride it's on the platform, not at the node;
//   - stopped, error (e.g. the missed-tag timeout) or manual, after such an
//     edge: its end, for an operator who stopped or drove it there. NavCore
//     re-plans from that node when it carries on.
// Ignored, with why: nothing it was driving to, the elevator ride still under
// way, or within CONFIRM_NAV_MIN_MS of starting toward that node (a double
// tap, or a repeat).
//
// Pure C++ (no Arduino or FreeRTOS calls), so test_host can drive it.

#pragma once

#include <stdint.h>

#include "../graph.h"
#include "../types.h"
#include "nav_core.h"

class ConfirmNav {
 public:
  // The NavOutput follow_edge() hook. Again for the same node (a resume)
  // keeps the time it started toward it.
  void on_edge(NodeIndex to, EdgeDrive drive, uint32_t now);
  // Every nav loop: Motion is driving an edge (Motion::driving_edge()), which
  // after an elevator ride means driving off the platform.
  void update(bool driving_edge);
  // Any node reached, a real tag or reached(): call before NavCore::on_tag(),
  // which may start the next edge.
  void on_tag();

  // node_reached: the node reached, or NO_NODE and why (for NavOutput::note()).
  NodeIndex reached(RobotStatus status, uint32_t now, const char** why) const;

 private:
  NodeIndex target_ = NO_NODE;  // the end of the last edge, until reached
  bool armed_ = false;          // driving to it (off the platform, after a ride)
  uint32_t since_ms_ = 0;       // when it started toward target_
};
