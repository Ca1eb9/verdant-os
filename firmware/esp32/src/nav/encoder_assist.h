// encoder_assist.h
// Optional encoder assist (ENCODER_ASSIST_ENABLED, docs/firmware-architecture.md
// "Encoder (optional)"): stands in for one missed tag.
//
// Counts are kept from the last real tag (forward positive), or, with ToF
// navigation, the last node it reached. Driving an edge with counts in
// ENCODER_EDGES, once the counts the way it drives pass ENCODER_PASS_RATIO of
// the edge's with no tag, check() gives the edge's end tag. The nav task hands it to NavCore::on_tag(), so the robot does what
// that tag would have made it do: arrive, start the elevator or dock approach
// (ToF), or carry on. Counts the other way take progress off, so a swapped A
// and B never guesses. Real tags always win: each one starts the count again.
//
// It guesses at most once in a row: after a guess it waits for a real tag
// (or a ToF node), and the missed-tag timeout (nav/motion) faults as before. Nor does it guess
// after any move that isn't along an edge it has counts for (creep, jog,
// drive, docking, an elevator ride, an edge not listed), as it no longer
// knows how far it is from the last tag. A stop or an obstacle hold keeps
// the count. No counts (encoder off or not wired): never guesses, the
// tags-only robot.
//
// Pure C++ (no Arduino or FreeRTOS calls), so test_host can drive it.

#pragma once

#include <stddef.h>
#include <stdint.h>

#include "../config.h"
#include "../graph.h"
#include "../types.h"
#include "nav_core.h"

class EncoderAssist {
 public:
  // `edges`: ENCODER_EDGES on the robot.
  EncoderAssist(const EncoderEdge* edges, size_t edge_count)
      : edges_(edges), edge_count_(edge_count) {}

  // A known tag was read: call before NavCore::on_tag(), which may start the
  // next edge.
  void on_tag();
  // The NavOutput motion hooks: follow_edge(), and every other move (creep,
  // jog, drive, start_docking).
  void on_edge(NodeIndex from, NodeIndex to, EdgeDrive drive);
  void on_untracked_move();
  // Encoder counts since the last call, forward positive.
  void on_counts(int32_t counts);
  // Every nav loop, after on_counts(): the tag to take as read, once, or
  // NO_NODE. Only while driving a path (en_route, returning_to_dock).
  NodeIndex check(RobotStatus status);

  // For the log: counts since the last tag, and the edge's (0: none).
  int32_t counts_since_tag() const { return counts_; }
  int32_t edge_counts() const { return edge_counts_; }
  // How much of the edge to `node` it has driven since the last tag (1: all
  // of it; just after reversing it can be a little under 0), or NAN when it
  // can't say (not that edge, no counts, or not placed). After a guess it
  // counts from the guessed node. ToF navigation checks its arrivals against it.
  float progress_to(NodeIndex node) const;
  // ToF reached the edge's end node, `past_cm` beyond it on an edge `edge_cm`
  // long (0: unknown), at `progress` (progress_to, or NAN). Like on_tag(), but
  // counting from where the robot is: that overshoot, or, if ToF came early
  // (under TOF_NAV_ENCODER_TRUST_RATIO), the encoder's own idea of the node.
  // An overshoot it can't convert and over TOF_NAV_MAX_STEP_CM: not placed.
  void on_tof_node(float progress, float past_cm, float edge_cm);
  // The guess check() just gave was refused (ToF says the robot isn't there:
  // a slipping wheel): count on from the last node again, and no other guess
  // until the next one.
  void drop_guess();
  // A real tag for the node the robot already took (by ToF or a guess), with
  // the next edge already started: count from here, keeping that edge.
  void resync();

 private:
  const EncoderEdge* edges_;
  size_t edge_count_;
  bool placed_ = false;   // counts_ is from a real tag, along known edges
  bool guessed_ = false;  // a guess since the last real tag
  int32_t counts_ = 0;
  // The edge being driven: its end, way and counts (0: no assist).
  NodeIndex to_ = NO_NODE;
  bool backward_ = false;
  int32_t edge_counts_ = 0;
};
