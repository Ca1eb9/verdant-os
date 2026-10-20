// encoder_assist.cpp
// See encoder_assist.h.

#include "encoder_assist.h"

#include <string.h>

void EncoderAssist::on_tag() {
  placed_ = true;
  guessed_ = false;
  counts_ = 0;
  // Until NavCore starts the next edge, if it does (not at a target).
  to_ = NO_NODE;
  edge_counts_ = 0;
}

void EncoderAssist::on_edge(NodeIndex from, NodeIndex to, EdgeDrive drive) {
  to_ = to;
  backward_ = drive == EdgeDrive::Backward;
  edge_counts_ = 0;
  // An elevator ride or a turn has no length to count.
  if (drive == EdgeDrive::Forward || drive == EdgeDrive::Backward) {
    for (size_t i = 0; i < edge_count_; i++) {
      if (strcmp(edges_[i].from, GRAPH_NODES[from].id) == 0 &&
          strcmp(edges_[i].to, GRAPH_NODES[to].id) == 0) {
        edge_counts_ = edges_[i].counts;
        break;
      }
    }
  }
  // The same edge again (resumed after a stop), or another from the same
  // tag (a new navigate), counts on from that tag. One it can't measure
  // leaves it not knowing where it is.
  if (edge_counts_ <= 0) placed_ = false;
}

void EncoderAssist::on_untracked_move() { placed_ = false; }

void EncoderAssist::on_counts(int32_t counts) { counts_ += counts; }

NodeIndex EncoderAssist::check(RobotStatus status) {
  if (!placed_ || guessed_ || edge_counts_ <= 0) return NO_NODE;
  if (status != RobotStatus::EnRoute && status != RobotStatus::ReturningToDock) return NO_NODE;
  int32_t along = backward_ ? -counts_ : counts_;
  if (along < ENCODER_PASS_RATIO * edge_counts_) return NO_NODE;
  guessed_ = true;
  return to_;
}
