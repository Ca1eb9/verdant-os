// tof_locator.cpp
// See tof_locator.h.

#include "tof_locator.h"

#include <math.h>
#include <stdio.h>

#include "../utils/nav_helpers.h"

namespace {

uint8_t level_of(NodeIndex n) { return (uint8_t)lround(GRAPH_NODES[n].z); }

// How far along ROBOT_HEADING a node is: the front board is that way, so
// front readings fall as this grows and rear readings rise.
double along(NodeIndex n) {
  const GraphNode& g = GRAPH_NODES[n];
  switch (ROBOT_HEADING) {
    case Heading::East: return g.x;
    case Heading::West: return -g.x;
    case Heading::North: return g.y;
    case Heading::South: return -g.y;
  }
  return g.x;
}

// A reading that isn't held over from an older one. now can be a few ms
// behind ms (the nav task's millis() is taken first).
bool fresh(float cm, uint32_t ms, uint32_t now) {
  return !isnan(cm) && ms != 0 && (int32_t)(now - ms) <= (int32_t)TOF_NAV_FRESH_MS;
}

// Fresh, and not a side whose obstacle flag is set: then it's something in
// the way, not a board.
bool usable(float cm, uint32_t ms, bool stop, uint32_t now) { return !stop && fresh(cm, ms, now); }

}  // namespace

const char* TofLocator::fail(const char* format, const char* id) {
  snprintf(error_, sizeof(error_), format, id);
  ready_ = false;
  return error_;
}

const char* TofLocator::begin() {
  ready_ = false;
  mode_ = Mode::Off;
  if (TOF_NAV_CONFIRM_COUNT == 0) return fail("TOF_NAV_CONFIRM_COUNT must be at least 1");
  if (!(TOF_ARRIVE_LEAD_CM >= 0 && TOF_ARRIVE_LEAD_CM < TOF_NAV_MAX_STEP_CM)) {
    return fail("TOF_ARRIVE_LEAD_CM must be from 0 to under TOF_NAV_MAX_STEP_CM");
  }

  bool listed[MAX_PATH_LEN] = {};
  for (uint8_t i = 0; i < GRAPH_NODE_COUNT; i++) front_[i] = rear_[i] = 0;
  for (size_t i = 0; i < node_count_; i++) {
    const TofNode& t = nodes_[i];
    NodeIndex n = node_by_id(t.node);
    if (n == NO_NODE) return fail("TOF_NODES: %s isn't in the graph", t.node ? t.node : "(null)");
    if (listed[n]) return fail("TOF_NODES: %s is listed twice", t.node);
    if (!(t.front_cm >= 0) || !(t.rear_cm >= 0)) return fail("TOF_NODES: %s has a negative reading", t.node);
    listed[n] = true;
    front_[n] = t.front_cm;
    rear_[n] = t.rear_cm;
  }

  bool boot_level = false;
  for (NodeIndex i = 0; i < GRAPH_NODE_COUNT; i++) {
    const char* id = GRAPH_NODES[i].id;
    if (!listed[i]) return fail("TOF_NODES: no entry for %s", id);
    if (front_[i] == 0 && rear_[i] == 0) return fail("TOF_NODES: %s has no reading yet (measure it)", id);
    // Driving toward the board, the obstacle stop would hold it short of the node.
    if ((front_[i] > 0 && front_[i] <= OBSTACLE_STOP_CM) || (rear_[i] > 0 && rear_[i] <= OBSTACLE_STOP_CM)) {
      return fail("TOF_NODES: %s is within OBSTACLE_STOP_CM of a board", id);
    }
    uint8_t level = level_of(i);
    if (level >= level_count_) return fail("TOF_LEVEL_LENGTH_CM has no entry for %s's level", id);
    if (level == TOF_BOOT_LEVEL) boot_level = true;
    // Every pair on a level, in order along the track: far enough apart to
    // tell apart, and falling toward the front board, rising away from the rear.
    for (NodeIndex j = 0; j < GRAPH_NODE_COUNT; j++) {
      if (j == i || level_of(j) != level || !(along(i) < along(j))) continue;
      if (front_[i] > 0 && front_[j] > 0 && front_[i] - front_[j] < TOF_MIN_NODE_GAP_CM) {
        return fail("TOF_NODES: %s's front reading isn't TOF_MIN_NODE_GAP_CM above the next node's", id);
      }
      if (rear_[i] > 0 && rear_[j] > 0 && rear_[j] - rear_[i] < TOF_MIN_NODE_GAP_CM) {
        return fail("TOF_NODES: %s's rear reading isn't TOF_MIN_NODE_GAP_CM below the next node's", id);
      }
    }
    for (NodeIndex j = 0; j < GRAPH_NODE_COUNT; j++) {
      if (j != i && level_of(j) == level && along(i) == along(j)) {
        return fail("TOF_NODES: %s shares its place on the level with another node", id);
      }
    }
  }
  if (!boot_level) return fail("TOF_BOOT_LEVEL has no nodes%s");

  ready_ = true;
  return nullptr;
}

void TofLocator::on_tag(NodeIndex /*node*/) {
  mode_ = Mode::Off;
  candidate_ = NO_NODE;
  away_ = false;
}

void TofLocator::on_edge(NodeIndex from, NodeIndex to, EdgeDrive drive) {
  mode_ = Mode::Off;
  fired_ = false;
  count_ = 0;
  track_cm_ = NAN;
  track_ms_ = 0;
  last_ms_ = 0;
  candidate_ = NO_NODE;
  away_ = false;
  if (!ready_ || drive == EdgeDrive::Turn || to >= GRAPH_NODE_COUNT) return;

  bool backward = drive == EdgeDrive::Backward || drive == EdgeDrive::ElevatorBackward;
  toward_ = (backward ? rear_[to] : front_[to]) > 0;
  use_rear_ = toward_ == backward;
  target_cm_ = use_rear_ ? rear_[to] : front_[to];
  if (!(target_cm_ > 0)) return;
  // The first reading should lie between the two nodes. `from` on another
  // level (an elevator ride) leaves that end open.
  float from_cm = 0;
  if (from < GRAPH_NODE_COUNT && level_of(from) == level_of(to)) {
    from_cm = use_rear_ ? rear_[from] : front_[from];
  }
  if (toward_) {
    seed_lo_cm_ = target_cm_ - TOF_NAV_MAX_STEP_CM;  // already past it (resumed)
    seed_hi_cm_ = from_cm > 0 ? from_cm + TOF_NAV_MAX_STEP_CM : INFINITY;
  } else {
    seed_lo_cm_ = from_cm > 0 ? from_cm - TOF_NAV_MAX_STEP_CM : -INFINITY;
    seed_hi_cm_ = target_cm_ + TOF_NAV_MAX_STEP_CM;
  }
  target_ = to;
  mode_ = Mode::Edge;
}

void TofLocator::on_creep() {
  on_edge(NO_NODE, NO_NODE, EdgeDrive::Turn);  // clears the edge
  if (ready_) mode_ = Mode::Creep;
}

void TofLocator::on_untracked_move() {
  mode_ = Mode::Off;
  candidate_ = NO_NODE;
}

bool TofLocator::past(float cm) const {
  // Toward the board the reading falls to the node's; away from it, it rises.
  return toward_ ? cm <= target_cm_ + TOF_ARRIVE_LEAD_CM : cm >= target_cm_ - TOF_ARRIVE_LEAD_CM;
}

NodeIndex TofLocator::check_edge(const TofSample& s, uint32_t now) {
  if (!ready_) return NO_NODE;
  if (mode_ == Mode::Creep) return check_creep(s, now);
  if (mode_ != Mode::Edge || fired_) return NO_NODE;

  float cm = use_rear_ ? s.rear_cm : s.front_cm;
  uint32_t ms = use_rear_ ? s.rear_ms : s.front_ms;
  bool stop = use_rear_ ? s.rear_stop : s.front_stop;
  if (!fresh(cm, ms, now) || ms == last_ms_) return NO_NODE;
  last_ms_ = ms;

  bool trusted;
  if (stop) {
    trusted = false;
  } else if (isnan(track_cm_)) {
    trusted = cm >= seed_lo_cm_ && cm <= seed_hi_cm_;
  } else {
    // Only time with no reading at all lets it have moved further: a
    // rejected reading still counts as seeing, so whatever is in the beam
    // never becomes trusted by staying there.
    int32_t gap_ms = (int32_t)(ms - track_ms_);
    float allowed = TOF_NAV_MAX_STEP_CM + TOF_NAV_MAX_SPEED_CM_S * (gap_ms > 0 ? gap_ms : 0) / 1000.0f;
    trusted = fabsf(cm - track_cm_) <= allowed;
  }
  if (!isnan(track_cm_) || trusted) track_ms_ = ms;
  if (!trusted) {
    count_ = 0;
    return NO_NODE;
  }
  track_cm_ = cm;

  if (!past(cm) || !length_ok(level_of(target_), s, now)) {
    count_ = 0;
    return NO_NODE;
  }
  if (++count_ < TOF_NAV_CONFIRM_COUNT) return NO_NODE;
  fired_ = true;
  return target_;
}

NodeIndex TofLocator::check_creep(const TofSample& s, uint32_t now) {
  // Each new reading (either side) counts once.
  uint32_t newest = (int32_t)(s.front_ms - s.rear_ms) > 0 ? s.front_ms : s.rear_ms;
  if (newest == last_ms_) return NO_NODE;
  last_ms_ = newest;
  NodeIndex m = match(TOF_BOOT_LEVEL, s, now);
  if (m == NO_NODE) {
    candidate_ = NO_NODE;
    count_ = 0;
    return NO_NODE;
  }
  if (m != candidate_) {
    candidate_ = m;
    count_ = 0;
  }
  if (++count_ < TOF_NAV_CONFIRM_COUNT) return NO_NODE;
  mode_ = Mode::Off;
  candidate_ = NO_NODE;
  return m;
}

NodeIndex TofLocator::localize(uint8_t level, NodeIndex current, const TofSample& s, uint32_t now) {
  if (!ready_) return NO_NODE;
  if (current != NO_NODE && current < GRAPH_NODE_COUNT && clearly_off(current, s, now)) away_ = true;
  NodeIndex m = match(level, s, now);
  // Like a tag: a robot left sitting on its node doesn't keep reading it.
  if (m == NO_NODE || (m == current && !away_)) {
    candidate_ = NO_NODE;
    return NO_NODE;
  }
  if (m != candidate_) {
    candidate_ = m;
    candidate_ms_ = now;
    return NO_NODE;
  }
  if ((int32_t)(now - candidate_ms_) < (int32_t)TOF_STILL_MS) return NO_NODE;
  candidate_ = NO_NODE;
  away_ = false;
  return m;
}

NodeIndex TofLocator::match(uint8_t level, const TofSample& s, uint32_t now) const {
  if (!length_ok(level, s, now)) return NO_NODE;
  auto side_ok = [&](float want, float cm, uint32_t ms, bool stop) {
    return want <= 0 || (usable(cm, ms, stop, now) && fabsf(cm - want) <= TOF_LOCALIZE_TOL_CM);
  };
  NodeIndex found = NO_NODE;
  for (NodeIndex i = 0; i < GRAPH_NODE_COUNT; i++) {
    if (level_of(i) != level) continue;
    if (!side_ok(front_[i], s.front_cm, s.front_ms, s.front_stop)) continue;
    if (!side_ok(rear_[i], s.rear_cm, s.rear_ms, s.rear_stop)) continue;
    if (found != NO_NODE) return NO_NODE;  // can't tell which
    found = i;
  }
  return found;
}

bool TofLocator::clearly_off(NodeIndex node, const TofSample& s, uint32_t now) const {
  auto off = [&](float want, float cm, uint32_t ms, bool stop) {
    return want > 0 && usable(cm, ms, stop, now) && fabsf(cm - want) > 2 * TOF_LOCALIZE_TOL_CM;
  };
  return off(front_[node], s.front_cm, s.front_ms, s.front_stop) ||
         off(rear_[node], s.rear_cm, s.rear_ms, s.rear_stop);
}

bool TofLocator::length_ok(uint8_t level, const TofSample& s, uint32_t now) const {
  if (level >= level_count_ || !(level_cm_[level] > 0)) return true;
  if (!fresh(s.front_cm, s.front_ms, now) || !fresh(s.rear_cm, s.rear_ms, now)) return true;
  return fabsf(s.front_cm + s.rear_cm - level_cm_[level]) <= TOF_NAV_LENGTH_TOL_CM;
}
