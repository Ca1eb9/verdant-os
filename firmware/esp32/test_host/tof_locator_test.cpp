// tof_locator_test.cpp
// Drives ToF navigation (src/nav/tof_locator) on a laptop, against the farm
// graph (src/graph.cpp). A made-up farm: each graph x unit is 50 cm along
// the track, the boards stand so that front = 230 - pos and rear = pos + 30
// (front + rear = 260 everywhere), on every level.
//
// Checks the table checks, an edge each way, the elevator drive-off, the boot
// creep, localising, and every reading it mustn't trust.
// Build + run with ./run.sh

#include <math.h>
#include <stdio.h>
#include <string.h>

#include <vector>

#include "config.h"
#include "nav/tof_locator.h"
#include "utils/nav_helpers.h"

static int failures = 0;
static const char* g_scenario = "";
#define CHECK(cond)                                                              \
  do {                                                                           \
    if (!(cond)) {                                                               \
      printf("  FAIL [%s] %s:%d  %s\n", g_scenario, __FILE__, __LINE__, #cond);  \
      failures++;                                                                \
    }                                                                            \
  } while (0)
#define SCENARIO(name) g_scenario = name;

static NodeIndex N(const char* id) {
  NodeIndex n = node_by_id(id);
  if (n == NO_NODE) printf("  test bug: no node %s\n", id);
  return n;
}

static const float LEVELS[] = {260, 260, 260};
static const float CM_PER_UNIT = 50;

static float pos_of(const char* id) { return (float)GRAPH_NODES[N(id)].x * CM_PER_UNIT; }

// The made-up farm's table, with every node measured on both sides.
static std::vector<TofNode> farm_table() {
  std::vector<TofNode> t;
  for (uint8_t i = 0; i < GRAPH_NODE_COUNT; i++) {
    float pos = (float)GRAPH_NODES[i].x * CM_PER_UNIT;
    t.push_back({GRAPH_NODES[i].id, 230 - pos, pos + 30});
  }
  return t;
}

// The robot on a track: a reading from each sensor every 33 ms.
struct Track {
  uint32_t now = 1000;
  float pos = 0;
  TofSample at(float p) {
    pos = p;
    now += 33;
    TofSample s = {};
    s.front_cm = 230 - p;
    s.front_ms = now;
    s.rear_cm = p + 30;
    s.rear_ms = now;
    return s;
  }
};

// Drives from `from` to `to` (cm), `step` a reading, checking each reading.
// Returns the position it fired at, or NAN.
static float drive(TofLocator& loc, Track& tr, float from, float to, float step, NodeIndex want,
                   int* fires = nullptr) {
  float fired_at = NAN;
  int count = 0;
  float dir = to > from ? 1 : -1;
  for (float p = from; dir * (to - p) >= 0; p += dir * step) {
    TofSample s = tr.at(p);
    NodeIndex n = loc.check_edge(s, tr.now);
    if (n != NO_NODE) {
      CHECK(n == want);
      if (isnan(fired_at)) fired_at = p;
      count++;
    }
  }
  if (fires) *fires = count;
  return fired_at;
}

static TofLocator ready_locator(std::vector<TofNode>& table) {
  TofLocator loc(table.data(), table.size(), LEVELS, 3);
  const char* err = loc.begin();
  if (err) printf("  test bug: %s\n", err);
  return loc;
}

static void expect_error(std::vector<TofNode> table, const char* part, const float* levels = LEVELS,
                         size_t level_count = 3) {
  TofLocator loc(table.data(), table.size(), levels, level_count);
  const char* err = loc.begin();
  CHECK(err != nullptr);
  CHECK(!loc.ready());
  if (err && !strstr(err, part)) {
    printf("  FAIL [%s] error '%s' doesn't mention '%s'\n", g_scenario, err, part);
    failures++;
  }
}

static TofNode& entry(std::vector<TofNode>& t, const char* id) {
  for (auto& e : t) {
    if (strcmp(e.node, id) == 0) return e;
  }
  printf("  test bug: no entry %s\n", id);
  return t[0];
}

static void table_checks() {
  SCENARIO("table: the made-up farm is usable");
  {
    auto t = farm_table();
    TofLocator loc(t.data(), t.size(), LEVELS, 3);
    CHECK(loc.begin() == nullptr);
    CHECK(loc.ready());
  }
  SCENARIO("table: config.h's unmeasured table isn't");
  {
    std::vector<TofNode> t(TOF_NODES, TOF_NODES + sizeof(TOF_NODES) / sizeof(TOF_NODES[0]));
    expect_error(t, "no reading yet", TOF_LEVEL_LENGTH_CM,
                 sizeof(TOF_LEVEL_LENGTH_CM) / sizeof(TOF_LEVEL_LENGTH_CM[0]));
  }
  SCENARIO("table: a node missing");
  {
    auto t = farm_table();
    t.pop_back();
    expect_error(t, "no entry for cp-22");
  }
  SCENARIO("table: a node listed twice");
  {
    auto t = farm_table();
    t.push_back(t[1]);
    expect_error(t, "listed twice");
  }
  SCENARIO("table: a node not in the graph");
  {
    auto t = farm_table();
    t.push_back({"cp-99", 100, 100});
    expect_error(t, "cp-99 isn't in the graph");
  }
  SCENARIO("table: a negative reading");
  {
    auto t = farm_table();
    entry(t, "cp-01").rear_cm = -1;
    expect_error(t, "negative");
  }
  SCENARIO("table: inside the obstacle stop");
  {
    auto t = farm_table();
    entry(t, "elev-1-L0").front_cm = OBSTACLE_CLEAR_CM;  // the flag would hold it short
    expect_error(t, "OBSTACLE_CLEAR_CM");
  }
  SCENARIO("table: out of order along the track");
  {
    auto t = farm_table();
    const float no_len[] = {0, 0, 0};  // or the front + rear check finds it first
    entry(t, "cp-01").front_cm = 100;  // below water-01's 130
    expect_error(t, "front reading", no_len, 3);
    t = farm_table();
    entry(t, "water-01").rear_cm = 60;  // below cp-01's 80
    expect_error(t, "rear reading", no_len, 3);
  }
  SCENARIO("table: two nodes too close to tell apart");
  {
    auto t = farm_table();
    entry(t, "cp-01").front_cm = 130 + TOF_MIN_NODE_GAP_CM - 1;
    const float no_len[] = {0, 0, 0};
    expect_error(t, "TOF_MIN_NODE_GAP_CM", no_len, 3);
  }
  SCENARIO("table: a level with no length entry");
  {
    auto t = farm_table();
    expect_error(t, "TOF_LEVEL_LENGTH_CM", LEVELS, 2);
  }
  SCENARIO("table: front + rear off the level's length (a typo)");
  {
    auto t = farm_table();
    entry(t, "water-01").rear_cm = 145;
    expect_error(t, "front + rear");
  }
  SCENARIO("table: a negative or NAN level length");
  {
    auto t = farm_table();
    const float bad[] = {260, -1, 260};
    expect_error(t, "TOF_LEVEL_LENGTH_CM", bad, 3);
    const float nan_len[] = {NAN, 260, 260};
    expect_error(t, "TOF_LEVEL_LENGTH_CM", nan_len, 3);
  }
  SCENARIO("table: one side only is fine");
  {
    auto t = farm_table();
    entry(t, "elev-1-L0").front_cm = 0;
    entry(t, "dock-1").rear_cm = 0;
    TofLocator loc(t.data(), t.size(), LEVELS, 3);
    CHECK(loc.begin() == nullptr);
  }
}

static void edges() {
  auto t = farm_table();

  SCENARIO("edge forward: reached at the node, once");
  {
    TofLocator loc = ready_locator(t);
    Track tr;
    loc.on_edge(N("cp-01"), N("water-01"), EdgeDrive::Forward);
    int fires = 0;
    float at = drive(loc, tr, 50, 130, 1, N("water-01"), &fires);
    CHECK(fires == 1);
    // Second reading at or past 100 cm (front 130).
    CHECK(at == 101);
  }
  SCENARIO("edge backward: the rear board, falling");
  {
    TofLocator loc = ready_locator(t);
    Track tr;
    loc.on_edge(N("water-01"), N("cp-01"), EdgeDrive::Backward);
    float at = drive(loc, tr, 100, 30, 1, N("cp-01"));
    CHECK(at == 49);
  }
  SCENARIO("edge: no reading for the side it drives toward uses the other");
  {
    auto t2 = farm_table();
    entry(t2, "water-01").front_cm = 0;
    TofLocator loc = ready_locator(t2);
    Track tr;
    loc.on_edge(N("cp-01"), N("water-01"), EdgeDrive::Forward);
    float at = drive(loc, tr, 50, 130, 1, N("water-01"));
    CHECK(at == 101);  // rear rising to 130
  }
  SCENARIO("edge: the same reading twice counts once");
  {
    TofLocator loc = ready_locator(t);
    Track tr;
    loc.on_edge(N("cp-01"), N("water-01"), EdgeDrive::Forward);
    drive(loc, tr, 50, 99, 1, NO_NODE);
    TofSample s = tr.at(100);
    CHECK(loc.check_edge(s, tr.now) == NO_NODE);
    CHECK(loc.check_edge(s, tr.now + 20) == NO_NODE);  // same reading, next nav loop
    s = tr.at(100.5f);
    CHECK(loc.check_edge(s, tr.now) == N("water-01"));
  }
  SCENARIO("edge: a stale reading isn't used");
  {
    TofLocator loc = ready_locator(t);
    Track tr;
    loc.on_edge(N("cp-01"), N("water-01"), EdgeDrive::Forward);
    drive(loc, tr, 50, 99, 1, NO_NODE);
    TofSample s = tr.at(100);
    CHECK(loc.check_edge(s, tr.now + TOF_NAV_FRESH_MS + 1) == NO_NODE);
    s = tr.at(101);
    CHECK(loc.check_edge(s, tr.now + TOF_NAV_FRESH_MS + 1) == NO_NODE);
    s = tr.at(102);
    s.front_cm = NAN;
    CHECK(loc.check_edge(s, tr.now) == NO_NODE);
  }
  SCENARIO("edge: a hand in the beam is never the node, however long it stays");
  {
    TofLocator loc = ready_locator(t);
    Track tr;
    loc.on_edge(N("cp-01"), N("water-01"), EdgeDrive::Forward);
    drive(loc, tr, 50, 70, 1, NO_NODE);
    // A hand at 120 cm (front reads 120 - pos, past the node's 130) while
    // the robot keeps driving up to it: never the node.
    for (float p = 70; p < 102; p += 0.5f) {
      TofSample s = tr.at(p);
      s.front_cm = 120 - p;
      s.front_stop = s.front_cm < OBSTACLE_STOP_CM;
      CHECK(loc.check_edge(s, tr.now) == NO_NODE);
    }
    // Hand gone, the robot a long way on (past the node): back on the board,
    // reached within the roll-on window.
    float at = drive(loc, tr, 102, 130, 1, N("water-01"));
    CHECK(!isnan(at) && at <= 106);
  }
  SCENARIO("edge: the obstacle flag on that side stops it counting");
  {
    TofLocator loc = ready_locator(t);
    Track tr;
    loc.on_edge(N("cp-01"), N("water-01"), EdgeDrive::Forward);
    drive(loc, tr, 50, 99, 1, NO_NODE);
    // Held by the flag at 100 cm (front 130, past the node).
    for (int i = 0; i < 10; i++) {
      TofSample s = tr.at(100);
      s.front_stop = true;
      CHECK(loc.check_edge(s, tr.now) == NO_NODE);
    }
    TofSample s = tr.at(101);
    CHECK(loc.check_edge(s, tr.now) == NO_NODE);  // count restarted
    s = tr.at(102);
    CHECK(loc.check_edge(s, tr.now) == N("water-01"));
  }
  SCENARIO("edge: readings that don't add up to the level's length");
  {
    TofLocator loc = ready_locator(t);
    Track tr;
    loc.on_edge(N("cp-01"), N("water-01"), EdgeDrive::Forward);
    drive(loc, tr, 50, 99, 1, NO_NODE);
    for (float p = 100; p < 110; p += 1) {
      TofSample s = tr.at(p);
      s.rear_cm = 20;  // something behind it
      CHECK(loc.check_edge(s, tr.now) == NO_NODE);
    }
    TofSample s = tr.at(110);
    s.rear_ms = 0;  // rear out of range: no length check
    CHECK(loc.check_edge(s, tr.now) == NO_NODE);
    s = tr.at(111);
    s.rear_cm = NAN;
    CHECK(loc.check_edge(s, tr.now) == N("water-01"));
  }
  SCENARIO("edge: a first reading outside the edge isn't trusted");
  {
    TofLocator loc = ready_locator(t);
    Track tr;
    loc.on_edge(N("cp-01"), N("water-01"), EdgeDrive::Forward);
    // Something 20 cm ahead from the start: never the node.
    for (int i = 0; i < 20; i++) {
      TofSample s = tr.at(50);
      s.front_cm = 20;
      CHECK(loc.check_edge(s, tr.now) == NO_NODE);
    }
    float at = drive(loc, tr, 50, 130, 1, N("water-01"));
    CHECK(at == 101);
  }
  SCENARIO("edge: resumed already past the node arrives");
  {
    TofLocator loc = ready_locator(t);
    Track tr;
    loc.on_edge(N("cp-01"), N("water-01"), EdgeDrive::Forward);
    drive(loc, tr, 50, 99.5f, 0.5f, NO_NODE);
    loc.on_untracked_move();  // stop
    loc.on_edge(N("cp-01"), N("water-01"), EdgeDrive::Forward);  // resume
    TofSample s = tr.at(103);
    CHECK(loc.check_edge(s, tr.now) == NO_NODE);
    s = tr.at(103);
    CHECK(loc.check_edge(s, tr.now) == N("water-01"));
  }
  SCENARIO("edge: no readings for a while, then further on");
  {
    TofLocator loc = ready_locator(t);
    Track tr;
    loc.on_edge(N("cp-01"), N("water-01"), EdgeDrive::Forward);
    drive(loc, tr, 50, 70, 1, NO_NODE);
    tr.now += 500;  // blind half a second: up to 6 + 30 cm further
    TofSample s = tr.at(98);
    CHECK(loc.check_edge(s, tr.now) == NO_NODE);
    float at = drive(loc, tr, 99, 130, 1, N("water-01"));
    CHECK(at == 101);
  }
  SCENARIO("edge: noisy readings (2-3 cm) never lose the node");
  {
    uint32_t seed = 12345;
    auto noise = [&](float sigma) {
      // Sum of uniforms, roughly Gaussian with this sigma.
      float sum = 0;
      for (int i = 0; i < 12; i++) {
        seed = seed * 1664525u + 1013904223u;
        sum += (seed >> 8) / 16777216.0f;
      }
      return (sum - 6) * sigma;
    };
    for (float sigma : {2.0f, 3.0f}) {
      int lost = 0, early = 0;
      for (int run = 0; run < 500; run++) {
        TofLocator loc = ready_locator(t);
        Track tr;
        loc.on_edge(N("cp-01"), N("water-01"), EdgeDrive::Forward);
        float at = NAN;
        for (float p = 50; p <= 140 && isnan(at); p += 1) {
          TofSample s = tr.at(p);
          s.front_cm += noise(sigma);
          s.rear_cm += noise(sigma);
          if (loc.check_edge(s, tr.now) != NO_NODE) at = p;
        }
        if (isnan(at)) lost++;
        else if (at < 100 - 3 * sigma) early++;
      }
      if (lost || early) printf("  sigma %.0f: %d lost, %d early of 500\n", sigma, lost, early);
      CHECK(lost == 0);
      CHECK(early == 0);
    }
  }
  SCENARIO("edge: backward on the trailing side (front rising)");
  {
    auto t2 = farm_table();
    entry(t2, "cp-01").rear_cm = 0;
    TofLocator loc = ready_locator(t2);
    Track tr;
    loc.on_edge(N("water-01"), N("cp-01"), EdgeDrive::Backward);
    float at = drive(loc, tr, 100, 30, 1, N("cp-01"));
    CHECK(at == 49);  // front 180 at 50
  }
  SCENARIO("edge: resumed after rolling on a stop's length past the node");
  {
    TofLocator loc = ready_locator(t);
    Track tr;
    loc.on_edge(N("cp-01"), N("water-01"), EdgeDrive::Forward);
    drive(loc, tr, 50, 98, 1, NO_NODE);
    loc.on_untracked_move();
    loc.on_edge(N("cp-01"), N("water-01"), EdgeDrive::Forward);
    float at = drive(loc, tr, 109, 115, 1, N("water-01"));
    CHECK(at == 110);
  }
  SCENARIO("edge: toward an elevator, the board behind (the platform may be gone)");
  {
    TofLocator loc = ready_locator(t);
    Track tr;
    loc.on_edge(N("cp-02"), N("elev-1-L0"), EdgeDrive::Forward);
    // Platform elsewhere: the front sees down the shaft. Rear rises to 230.
    float at = NAN;
    for (float p = 150; p <= 210 && isnan(at); p += 1) {
      TofSample s = tr.at(p);
      s.front_cm = 400;
      if (loc.check_edge(s, tr.now) == N("elev-1-L0")) at = p;
    }
    CHECK(at == 201);
  }
  SCENARIO("elevator: driving off forward, front board");
  {
    TofLocator loc = ready_locator(t);
    Track tr;
    // A platform west of its level's nodes would drive off forward: front
    // falls to elev-1-L1's 30 cm (pos 200) here.
    loc.on_edge(N("elev-1-L0"), N("elev-1-L1"), EdgeDrive::ElevatorForward);
    float at = drive(loc, tr, 180, 210, 1, N("elev-1-L1"));
    CHECK(at == 201);
  }
  SCENARIO("edge: a turn, or not ready, does nothing");
  {
    TofLocator loc = ready_locator(t);
    Track tr;
    loc.on_edge(N("cp-01"), N("water-01"), EdgeDrive::Turn);
    CHECK(isnan(drive(loc, tr, 50, 130, 1, NO_NODE)));
    std::vector<TofNode> zeros(TOF_NODES, TOF_NODES + sizeof(TOF_NODES) / sizeof(TOF_NODES[0]));
    TofLocator off(zeros.data(), zeros.size(), LEVELS, 3);
    CHECK(off.begin() != nullptr);
    off.on_edge(N("cp-01"), N("water-01"), EdgeDrive::Forward);
    Track tr2;
    CHECK(isnan(drive(off, tr2, 50, 130, 1, NO_NODE)));
    off.on_creep();
    CHECK(isnan(drive(off, tr2, 0, 200, 1, NO_NODE)));
    TofSample s = tr2.at(50);
    CHECK(off.localize(0, NO_NODE, s, tr2.now) == NO_NODE);
  }
  SCENARIO("edge: a real tag first means no ToF arrival for that edge");
  {
    TofLocator loc = ready_locator(t);
    Track tr;
    loc.on_edge(N("cp-01"), N("water-01"), EdgeDrive::Forward);
    drive(loc, tr, 50, 98, 1, NO_NODE);
    loc.on_tag(N("water-01"));
    CHECK(isnan(drive(loc, tr, 99, 110, 1, NO_NODE)));
  }
  SCENARIO("edge: a path, edge after edge");
  {
    TofLocator loc = ready_locator(t);
    Track tr;
    const char* path[] = {"dock-1", "cp-01", "water-01", "cp-02"};
    float p = 0;
    for (int i = 0; i + 1 < 4; i++) {
      loc.on_edge(N(path[i]), N(path[i + 1]), EdgeDrive::Forward);
      float at = drive(loc, tr, p, pos_of(path[i + 1]) + 5, 1, N(path[i + 1]));
      CHECK(!isnan(at));
      loc.on_tag(N(path[i + 1]));
      p = at + 1;
    }
  }
  SCENARIO("elevator: the drive-off on the new level, rear board");
  {
    TofLocator loc = ready_locator(t);
    Track tr;
    // Drove on forward, so off backward: toward the rear board, falling to 230.
    loc.on_edge(N("elev-1-L0"), N("elev-1-L1"), EdgeDrive::ElevatorBackward);
    float at = drive(loc, tr, 225, 150, 1, N("elev-1-L1"));
    CHECK(at == 199);
  }
}

static void creep_and_localize() {
  auto t = farm_table();

  SCENARIO("creep: the first node on the boot level it's on");
  {
    TofLocator loc = ready_locator(t);
    Track tr;
    loc.on_creep();
    float at = drive(loc, tr, 20, 80, 0.5f, N("cp-01"));
    CHECK(at == 50 - TOF_LOCALIZE_TOL_CM + 0.5f);
  }
  SCENARIO("creep: starting on a node");
  {
    TofLocator loc = ready_locator(t);
    Track tr;
    loc.on_creep();
    float at = drive(loc, tr, 100, 102, 0.5f, N("water-01"));
    CHECK(at == 100.5f);
  }
  SCENARIO("creep: a node on another level isn't taken");
  {
    auto t2 = farm_table();
    // L0's nodes measured differently from L1's: on L1's numbers, nothing on L0 matches.
    for (auto& e : t2) {
      if (GRAPH_NODES[N(e.node)].z == 0) {
        e.front_cm += 3 * TOF_LOCALIZE_TOL_CM;
        e.rear_cm += 3 * TOF_LOCALIZE_TOL_CM;
      }
    }
    const float no_len[] = {0, 0, 0};
    TofLocator loc(t2.data(), t2.size(), no_len, 3);
    CHECK(loc.begin() == nullptr);
    Track tr;
    loc.on_creep();
    CHECK(isnan(drive(loc, tr, 140, 160, 0.5f, NO_NODE)));  // cp-11 is at 150 on L1
  }

  SCENARIO("creep: one side never read, past 2^31 ms of uptime");
  {
    TofLocator loc = ready_locator(t);
    loc.on_creep();
    Track tr;
    tr.now = 0x80000100u;
    // rear never read: only the front, matching nothing two-sided; then both.
    NodeIndex got = NO_NODE;
    for (int i = 0; i < 5 && got == NO_NODE; i++) {
      TofSample s = tr.at(50);
      got = loc.check_edge(s, tr.now);
    }
    CHECK(got == N("cp-01"));
    TofLocator loc2 = ready_locator(t);
    loc2.on_creep();
    got = NO_NODE;
    for (int i = 0; i < 5; i++) {
      TofSample s = tr.at(50);
      s.rear_ms = 0;
      s.rear_cm = NAN;
      CHECK(loc2.check_edge(s, tr.now) == NO_NODE);  // cp-01 needs its rear too
    }
  }

  SCENARIO("update: after driving off an elevator, the new level, even with the old node");
  {
    TofLocator loc = ready_locator(t);
    Track tr;
    loc.on_tag(N("elev-1-L0"));
    loc.on_edge(N("elev-1-L0"), N("elev-1-L1"), EdgeDrive::ElevatorBackward);
    TofSample s = tr.at(225);  // on the platform, starting to drive off
    CHECK(loc.check_edge(s, tr.now) == NO_NODE);
    loc.on_untracked_move();  // faulted, then driven by hand
    CHECK(loc.level_known());
    NodeIndex got = NO_NODE;
    for (int i = 0; i < 100 && got == NO_NODE; i++) {
      s = tr.at(150);
      got = loc.update(false, RobotStatus::Manual, N("elev-1-L0"), s, tr.now);
    }
    CHECK(got == N("cp-11"));
  }
  SCENARIO("update: a ride cut short, the level is unknown until a real tag");
  {
    TofLocator loc = ready_locator(t);
    Track tr;
    loc.on_tag(N("elev-1-L0"));
    loc.on_edge(N("elev-1-L0"), N("elev-1-L1"), EdgeDrive::ElevatorBackward);
    loc.on_edge(N("elev-1-L0"), N("elev-1-L1"), EdgeDrive::ElevatorBackward);  // resumed: same ride
    CHECK(loc.level_known());
    loc.on_edge(N("elev-1-L0"), N("cp-02"), EdgeDrive::Backward);  // return_to_dock mid-ride
    CHECK(!loc.level_known());
    CHECK(isnan(drive(loc, tr, 200, 140, 1, NO_NODE)));
    for (int i = 0; i < 100; i++) {
      TofSample s = tr.at(150);
      CHECK(loc.update(false, RobotStatus::Manual, N("elev-1-L0"), s, tr.now) == NO_NODE);
    }
    loc.on_tag(N("cp-11"));  // a real tag
    CHECK(loc.level_known());
  }
  SCENARIO("update: nothing in error, idle, stopped, working or a dock trip");
  {
    TofLocator loc = ready_locator(t);
    Track tr;
    for (RobotStatus st : {RobotStatus::Error, RobotStatus::Idle, RobotStatus::Stopped,
                           RobotStatus::Working, RobotStatus::Docking, RobotStatus::Charging}) {
      for (int i = 0; i < 100; i++) {
        TofSample s = tr.at(100);
        CHECK(loc.update(false, st, N("cp-01"), s, tr.now) == NO_NODE);
      }
    }
  }

  SCENARIO("localize: left sitting on its node, nothing");
  {
    TofLocator loc = ready_locator(t);
    Track tr;
    for (int i = 0; i < 100; i++) {
      TofSample s = tr.at(50);
      CHECK(loc.localize(0, N("cp-01"), s, tr.now) == NO_NODE);
    }
  }
  SCENARIO("localize: off and back onto its node, still: that node");
  {
    TofLocator loc = ready_locator(t);
    Track tr;
    TofSample s = tr.at(80);
    for (uint32_t start = tr.now; tr.now - start <= TOF_STILL_MS + 50; s = tr.at(80)) {
      CHECK(loc.localize(0, N("cp-01"), s, tr.now) == NO_NODE);
    }
    NodeIndex got = NO_NODE;
    uint32_t start = 0;
    for (int i = 0; i < 100 && got == NO_NODE; i++) {
      s = tr.at(51);
      if (!start) start = tr.now;
      got = loc.localize(0, N("cp-01"), s, tr.now);
    }
    CHECK(got == N("cp-01"));
    CHECK(tr.now - start >= TOF_STILL_MS);
    // Then not again while it sits there.
    for (int i = 0; i < 100; i++) {
      s = tr.at(50);
      CHECK(loc.localize(0, N("cp-01"), s, tr.now) == NO_NODE);
    }
  }
  SCENARIO("localize: someone walking past a robot left on its node");
  {
    TofLocator loc = ready_locator(t);
    Track tr;
    for (int i = 0; i < 100; i++) {
      TofSample s = tr.at(50);
      if (i >= 10 && i < 13) s.front_cm = 90;  // a person, briefly
      CHECK(loc.localize(0, N("cp-01"), s, tr.now) == NO_NODE);
    }
    // Even with the length check off.
    const float no_len[] = {0, 0, 0};
    TofLocator loc2(t.data(), t.size(), no_len, 3);
    CHECK(loc2.begin() == nullptr);
    for (int i = 0; i < 100; i++) {
      TofSample s = tr.at(50);
      if (i >= 10 && i < 13) s.front_cm = 90;
      CHECK(loc2.localize(0, N("cp-01"), s, tr.now) == NO_NODE);
    }
  }
  SCENARIO("localize: a different node, once still");
  {
    TofLocator loc = ready_locator(t);
    Track tr;
    NodeIndex got = NO_NODE;
    for (int i = 0; i < 100 && got == NO_NODE; i++) {
      TofSample s = tr.at(100);
      got = loc.localize(0, N("cp-01"), s, tr.now);
    }
    CHECK(got == N("water-01"));
  }
  SCENARIO("localize: before the first node, on the boot level");
  {
    TofLocator loc = ready_locator(t);
    Track tr;
    NodeIndex got = NO_NODE;
    for (int i = 0; i < 100 && got == NO_NODE; i++) {
      TofSample s = tr.at(150);
      got = loc.localize(TOF_BOOT_LEVEL, NO_NODE, s, tr.now);
    }
    CHECK(got == N("cp-02"));
  }
  SCENARIO("localize: moving through a node isn't still");
  {
    TofLocator loc = ready_locator(t);
    Track tr;
    for (float p = 0; p < 200; p += 1) {
      TofSample s = tr.at(p);
      CHECK(loc.localize(0, NO_NODE, s, tr.now) == NO_NODE);
    }
  }
  SCENARIO("localize: a reading that doesn't add up, or stale, isn't a node");
  {
    TofLocator loc = ready_locator(t);
    Track tr;
    for (int i = 0; i < 100; i++) {
      TofSample s = tr.at(100);
      s.rear_cm += 3 * TOF_NAV_LENGTH_TOL_CM;
      CHECK(loc.localize(0, NO_NODE, s, tr.now) == NO_NODE);
    }
    for (int i = 0; i < 100; i++) {
      TofSample s = tr.at(100);
      CHECK(loc.localize(0, NO_NODE, s, tr.now + TOF_NAV_FRESH_MS + 1) == NO_NODE);
    }
  }
  SCENARIO("localize: one-sided nodes that both match can't be told apart");
  {
    auto t2 = farm_table();
    // water-01 by its front only, cp-02 by its rear only, measured so that
    // at 125 cm both are within tolerance.
    entry(t2, "water-01").rear_cm = 0;
    entry(t2, "water-01").front_cm = 105;
    entry(t2, "cp-02").front_cm = 0;
    entry(t2, "cp-02").rear_cm = 155;
    entry(t2, "cp-01").front_cm = 180;
    TofLocator loc = ready_locator(t2);
    CHECK(loc.ready());
    Track tr;
    for (int i = 0; i < 100; i++) {
      TofSample s = tr.at(125);
      CHECK(loc.localize(0, NO_NODE, s, tr.now) == NO_NODE);
    }
  }
}

int main() {
  table_checks();
  edges();
  creep_and_localize();
  if (failures) {
    printf("tof_locator_test: %d failure(s)\n", failures);
    return 1;
  }
  printf("tof_locator_test: passed\n");
  return 0;
}
