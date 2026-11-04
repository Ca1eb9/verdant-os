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

// How far the robot rolls on while a stop ramps down from top speed: a stop
// pressed just before a node can leave it this far past.
constexpr float ROLL_ON_CM = TOF_NAV_MAX_SPEED_CM_S * STOP_RAMP_MS / 2000.0f;

static_assert(2 * TOF_LOCALIZE_TOL_CM < TOF_MIN_NODE_GAP_CM,
              "two nodes TOF_MIN_NODE_GAP_CM apart could both match within TOF_LOCALIZE_TOL_CM");
// A reading is a measurement (TOF_TIMING_BUDGET_US) old when the sensor task
// polls it, and reaches nav a loop or two later.
static_assert(TOF_NAV_FRESH_MS > TOF_TIMING_BUDGET_US / 1000 + SENSOR_PERIOD_MS + NAV_LOOP_MS,
              "TOF_NAV_FRESH_MS is too short: no reading would ever be fresh");

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
    if (!(t.front_cm >= 0) || !(t.rear_cm >= 0)) {
      return fail("TOF_NODES: %s has a negative (or not a number) reading", t.node);
    }
    listed[n] = true;
    front_[n] = t.front_cm;
    rear_[n] = t.rear_cm;
  }

  bool boot_level = false;
  for (NodeIndex i = 0; i < GRAPH_NODE_COUNT; i++) {
    const char* id = GRAPH_NODES[i].id;
    if (!listed[i]) return fail("TOF_NODES: no entry for %s", id);
    if (front_[i] == 0 && rear_[i] == 0) return fail("TOF_NODES: %s has no reading yet (measure it)", id);
    // Driving toward the board, the obstacle flag (set under OBSTACLE_STOP_CM,
    // cleared only above OBSTACLE_CLEAR_CM) would hold it short of the node.
    if ((front_[i] > 0 && front_[i] <= OBSTACLE_CLEAR_CM) || (rear_[i] > 0 && rear_[i] <= OBSTACLE_CLEAR_CM)) {
      return fail("TOF_NODES: %s is within OBSTACLE_CLEAR_CM of a board (use 0 for that side)", id);
    }
    // Out of range it never reads, and the robot would drive on to the board.
    if (front_[i] > TOF_NAV_MAX_RANGE_CM || rear_[i] > TOF_NAV_MAX_RANGE_CM) {
      return fail("TOF_NODES: %s reads beyond TOF_NAV_MAX_RANGE_CM (use 0 for that side)", id);
    }
    uint8_t level = level_of(i);
    if (level >= level_count_ || level >= MAX_PATH_LEN) {
      return fail("TOF_LEVEL_LENGTH_CM has no entry for %s's level", id);
    }
    if (!(level_cm_[level] >= 0)) {
      return fail("TOF_LEVEL_LENGTH_CM: %s's level has a negative (or not a number) length", id);
    }
    if (level == TOF_BOOT_LEVEL) boot_level = true;
    // Every pair on a level, in order along the track: far enough apart to
    // tell apart, and falling toward the front board, rising away from the rear.
    for (NodeIndex j = 0; j < GRAPH_NODE_COUNT; j++) {
      if (j == i || level_of(j) != level || !(along(i) < along(j))) continue;
      if (front_[i] > 0 && front_[j] > 0 && front_[i] - front_[j] < TOF_MIN_NODE_GAP_CM) {
        return fail("TOF_NODES: %s's front reading must be TOF_MIN_NODE_GAP_CM above every node's further along", id);
      }
      if (rear_[i] > 0 && rear_[j] > 0 && rear_[j] - rear_[i] < TOF_MIN_NODE_GAP_CM) {
        return fail("TOF_NODES: %s's rear reading must be TOF_MIN_NODE_GAP_CM below every node's further along", id);
      }
    }
    for (NodeIndex j = 0; j < GRAPH_NODE_COUNT; j++) {
      if (j != i && level_of(j) == level && along(i) == along(j)) {
        return fail("TOF_NODES: %s shares its place on the level with another node", id);
      }
    }
  }
  if (!boot_level) return fail("TOF_BOOT_LEVEL has no nodes");

  // Each level's front + rear: as set, else the average of its two-sided
  // nodes. Every two-sided node must agree (a typo on one side could never
  // be matched).
  for (size_t level = 0; level < level_count_ && level < MAX_PATH_LEN; level++) {
    float sum = 0;
    int count = 0;
    for (NodeIndex i = 0; i < GRAPH_NODE_COUNT; i++) {
      if (level_of(i) == level && front_[i] > 0 && rear_[i] > 0) {
        sum += front_[i] + rear_[i];
        count++;
      }
    }
    length_[level] = level_cm_[level] > 0 ? level_cm_[level] : (count ? sum / count : 0);
    for (NodeIndex i = 0; i < GRAPH_NODE_COUNT; i++) {
      if (level_of(i) == level && front_[i] > 0 && rear_[i] > 0 &&
          fabsf(front_[i] + rear_[i] - length_[level]) > TOF_NAV_LENGTH_TOL_CM) {
        return fail("TOF_NODES: %s's front + rear doesn't match its level's", GRAPH_NODES[i].id);
      }
    }
  }

  ready_ = true;
  return nullptr;
}

void TofLocator::on_tag(NodeIndex node) {
  if (node < GRAPH_NODE_COUNT) {
    level_ = level_of(node);
    level_known_ = true;
    riding_ = false;
  }
  mode_ = Mode::Off;
  candidate_ = NO_NODE;
  away_ = false;
  off_since_ms_ = 0;
}

void TofLocator::on_edge(NodeIndex from, NodeIndex to, EdgeDrive drive) {
  mode_ = Mode::Off;
  fired_ = false;
  count_ = 0;
  track_cm_ = NAN;
  track_ms_ = 0;
  last_ms_ = 0;
  rejected_ = 0;
  candidate_ = NO_NODE;
  away_ = false;
  off_since_ms_ = 0;
  // A ride only ends with its drive-off (check_edge). Anything else first (a
  // stop and another command, a forced return): the elevator may or may not
  // have moved. The same ride again (resumed) carries on.
  bool ride = drive == EdgeDrive::ElevatorForward || drive == EdgeDrive::ElevatorBackward;
  if (riding_ && !(ride && from == ride_from_ && to == ride_to_)) lose_level();
  if (ride && level_known_) {
    riding_ = true;
    ride_from_ = from;
    ride_to_ = to;
  }
  if (!ready_ || !level_known_ || drive == EdgeDrive::Turn || to >= GRAPH_NODE_COUNT) return;

  bool backward = drive == EdgeDrive::Backward || drive == EdgeDrive::ElevatorBackward;
  bool same_level = from < GRAPH_NODE_COUNT && level_of(from) == level_of(to);
  float ahead_cm = backward ? rear_[to] : front_[to];
  float behind_cm = backward ? front_[to] : rear_[to];
  // Toward the elevator, the board ahead is the platform's end wall, which
  // isn't there while the platform is on another level: use the board behind.
  bool to_elevator = same_level && GRAPH_NODES[to].type == NodeType::Elevator;
  toward_ = ahead_cm > 0 && !(to_elevator && behind_cm > 0);
  use_rear_ = toward_ == backward;
  target_cm_ = use_rear_ ? rear_[to] : front_[to];
  if (!(target_cm_ > 0)) return;
  // The first reading should lie between the two nodes, or a stop's roll-on
  // past the end one (resumed). `from` on another level (an elevator ride)
  // leaves that end open.
  float from_cm = same_level ? (use_rear_ ? rear_[from] : front_[from]) : 0;
  float past_cm = TOF_NAV_MAX_STEP_CM + ROLL_ON_CM;
  if (toward_) {
    seed_lo_cm_ = target_cm_ - past_cm;
    seed_hi_cm_ = from_cm > 0 ? from_cm + TOF_NAV_MAX_STEP_CM : INFINITY;
  } else {
    seed_lo_cm_ = from_cm > 0 ? from_cm - TOF_NAV_MAX_STEP_CM : -INFINITY;
    seed_hi_cm_ = target_cm_ + past_cm;
  }
  target_ = to;
  mode_ = Mode::Edge;
}

void TofLocator::on_creep() {
  on_edge(NO_NODE, NO_NODE, EdgeDrive::Turn);  // clears the edge
  if (ready_ && level_known_) mode_ = Mode::Creep;
}

void TofLocator::on_untracked_move() {
  if (riding_) lose_level();
  mode_ = Mode::Off;
  candidate_ = NO_NODE;
}

void TofLocator::lose_level() {
  riding_ = false;
  level_known_ = false;
}

void TofLocator::reject() {
  if (mode_ != Mode::Edge) return;
  fired_ = false;
  count_ = 0;
  rejected_ = 0;
  track_cm_ = NAN;
}

bool TofLocator::past(float cm) const {
  // Toward the board the reading falls to the node's; away from it, it rises.
  return toward_ ? cm <= target_cm_ + TOF_ARRIVE_LEAD_CM : cm >= target_cm_ - TOF_ARRIVE_LEAD_CM;
}

NodeIndex TofLocator::update(bool on_track, RobotStatus status, NodeIndex current,
                             const TofSample& s, uint32_t now) {
  if (on_track) return check_edge(s, now);
  // Driven by hand (in error, that's manual), or set down before the first
  // node: the node it's on. Not in error itself, where nothing moves it, so
  // someone standing in a beam can't restart it.
  if (status != RobotStatus::Manual && status != RobotStatus::Initializing) return NO_NODE;
  return localize(level_, current, s, now);
}

NodeIndex TofLocator::check_edge(const TofSample& s, uint32_t now) {
  if (!ready_ || !level_known_) return NO_NODE;
  if (mode_ == Mode::Creep) return check_creep(s, now);
  if (mode_ != Mode::Edge || fired_) return NO_NODE;
  // Driving again after a ride: off the platform, on the new level.
  if (riding_) {
    riding_ = false;
    level_ = level_of(target_);
  }

  float cm = use_rear_ ? s.rear_cm : s.front_cm;
  uint32_t ms = use_rear_ ? s.rear_ms : s.front_ms;
  bool stop = use_rear_ ? s.rear_stop : s.front_stop;
  if (!fresh(cm, ms, now) || ms == last_ms_) return NO_NODE;
  last_ms_ = ms;

  uint8_t level = level_of(target_);
  bool trusted;
  if (stop) {
    trusted = false;
  } else if (isnan(track_cm_)) {
    trusted = cm >= seed_lo_cm_ && cm <= seed_hi_cm_ && length_ok(level, s, now);
  } else {
    // The robot can't have moved further than this since the last reading
    // seen. A rejected one counts as seen, so a run of them doesn't widen it.
    int32_t gap_ms = (int32_t)(ms - track_ms_);
    float allowed = TOF_NAV_MAX_STEP_CM + TOF_NAV_MAX_SPEED_CM_S * (gap_ms > 0 ? gap_ms : 0) / 1000.0f;
    trusted = fabsf(cm - track_cm_) <= allowed;
  }
  if (!isnan(track_cm_) || trusted) track_ms_ = ms;
  if (!trusted) {
    count_ = 0;
    // The robot kept moving meanwhile (noise, a leaf, a hand that's gone):
    // start again from the edge's bounds rather than the stale reading.
    if (!isnan(track_cm_) && ++rejected_ >= TOF_NAV_RESEED_COUNT) {
      track_cm_ = NAN;
      rejected_ = 0;
    }
    return NO_NODE;
  }
  rejected_ = 0;
  track_cm_ = cm;

  // Further on than a stop's roll-on past it: the node was missed (or this
  // is something in the beam). Later than that is wrong, not late.
  bool too_far = toward_ ? cm < seed_lo_cm_ : cm > seed_hi_cm_;
  // A node with both readings is only taken with both boards in view, so the
  // length check can see an object parked in a beam.
  bool both_seen = !(length_[level] > 0 && front_[target_] > 0 && rear_[target_] > 0) ||
                   (fresh(s.front_cm, s.front_ms, now) && fresh(s.rear_cm, s.rear_ms, now));
  if (!past(cm) || too_far || !both_seen || !length_ok(level, s, now)) {
    count_ = 0;
    return NO_NODE;
  }
  if (++count_ < TOF_NAV_CONFIRM_COUNT) return NO_NODE;
  fired_ = true;
  return target_;
}

NodeIndex TofLocator::check_creep(const TofSample& s, uint32_t now) {
  // Each new reading (either side) counts once. 0: that side never read.
  uint32_t newest = s.front_ms;
  if (s.rear_ms != 0 && (newest == 0 || (int32_t)(s.rear_ms - newest) > 0)) newest = s.rear_ms;
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
    candidate_ms_ = now;
    count_ = 0;
  }
  if (++count_ < TOF_NAV_CONFIRM_COUNT) return NO_NODE;
  mode_ = Mode::Off;
  candidate_ = NO_NODE;
  return m;
}

NodeIndex TofLocator::localize(uint8_t level, NodeIndex current, const TofSample& s, uint32_t now) {
  if (!ready_ || !level_known_) return NO_NODE;
  // Clearly off its node for TOF_STILL_MS, readings that add up: it was moved.
  // Not one passing reading (someone walking by).
  if (current < GRAPH_NODE_COUNT && length_ok(level, s, now) && clearly_off(current, s, now)) {
    if (off_since_ms_ == 0) off_since_ms_ = now;
    if ((int32_t)(now - off_since_ms_) >= (int32_t)TOF_STILL_MS) away_ = true;
  } else {
    off_since_ms_ = 0;
  }
  NodeIndex m = match(level, s, now);
  // A reading just outside the tolerance (noise) keeps the candidate's time,
  // unless it's clearly off it.
  if (m == NO_NODE && candidate_ != NO_NODE && !clearly_off(candidate_, s, now)) return NO_NODE;
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
  if (level >= level_count_ || level >= MAX_PATH_LEN || !(length_[level] > 0)) return true;
  if (!fresh(s.front_cm, s.front_ms, now) || !fresh(s.rear_cm, s.rear_ms, now)) return true;
  // Something in a beam only ever makes the sum shorter. Longer: a board
  // isn't there (the elevator platform on another level), so it can't check.
  return s.front_cm + s.rear_cm - length_[level] >= -TOF_NAV_LENGTH_TOL_CM;
}
