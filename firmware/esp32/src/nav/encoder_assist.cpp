// encoder_assist.cpp
// See encoder_assist.h.

#include "encoder_assist.h"

#include <math.h>
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

void EncoderAssist::resync() {
  placed_ = true;
  guessed_ = false;
  counts_ = 0;
}

void EncoderAssist::on_counts(int32_t counts) { counts_ += counts; }

void EncoderAssist::on_tof_node(float progress, float past_cm, float edge_cm) {
  int32_t sign = backward_ ? -1 : 1;
  bool measured = edge_counts_ > 0;
  if (placed_ && measured && !isnan(progress) && progress < TOF_NAV_ENCODER_TRUST_RATIO) {
    counts_ -= sign * edge_counts_;
    placed_ = true;
  } else if (measured && edge_cm > 0) {
    counts_ = sign * (int32_t)lround(past_cm / edge_cm * edge_counts_);
    placed_ = true;
  } else {
    counts_ = 0;
    placed_ = past_cm <= TOF_NAV_MAX_STEP_CM;
  }
  guessed_ = false;
  to_ = NO_NODE;
  edge_counts_ = 0;
}

void EncoderAssist::drop_guess() {
  counts_ += backward_ ? -edge_counts_ : edge_counts_;  // undo check()'s re-base
}

float EncoderAssist::progress_to(NodeIndex node) const {
  if (!placed_ || edge_counts_ <= 0 || node != to_) return NAN;
  int32_t along = backward_ ? -counts_ : counts_;
  return (float)along / edge_counts_;
}

NodeIndex EncoderAssist::check(RobotStatus status) {
  if (!placed_ || guessed_ || edge_counts_ <= 0) return NO_NODE;
  if (status != RobotStatus::EnRoute && status != RobotStatus::ReturningToDock) return NO_NODE;
  int32_t along = backward_ ? -counts_ : counts_;
  if (along < ENCODER_PASS_RATIO * edge_counts_) return NO_NODE;
  guessed_ = true;
  // Count on from the guessed node, as if its tag had been read there, so the
  // next edge's progress (progress_to) means something.
  counts_ -= backward_ ? -edge_counts_ : edge_counts_;
  return to_;
}
