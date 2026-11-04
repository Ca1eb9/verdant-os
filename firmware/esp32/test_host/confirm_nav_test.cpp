// confirm_nav_test.cpp
// Confirmed navigation (src/nav/confirm_nav, CONFIRM_NAV_ENABLED) wired to
// NavCore and Motion the way the nav task does, against the farm graph
// (src/graph.cpp), with no tags at all:
//
//   dock-1 - cp-01 - water-01 - cp-02 - elev-1-L0 = elev-1-L1 - cp-11 ...
//
// Each tap is a node_reached: the node the robot was driving to, as if its
// tag were read. Build + run with ./run.sh

#include <math.h>
#include <stdio.h>
#include <string.h>

#include <string>
#include <vector>

#include "config.h"
#include "nav/confirm_nav.h"
#include "nav/motion.h"
#include "nav/nav_core.h"
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

static const char* at(NodeIndex n) { return n == NO_NODE ? "none" : GRAPH_NODES[n].id; }
static bool same(const char* a, const char* b) { return strcmp(a, b) == 0; }

class Sink : public DriveSink {
 public:
  void send(const DriveCommand&) override {}
};

// The nav task's wiring: hooks into Motion and ConfirmNav, one loop per step().
class Rig : public NavOutput {
 public:
  Sink sink;
  Motion motion{sink};
  ConfirmNav confirm;
  NavCore core{*this};
  uint32_t now = 1000;
  std::string last_edge;
  std::vector<RobotEventType> events;
  const char* last_note = "";
  SensorData sensors = {};

  Rig() {
    sensors.obstacle_front_cm = NAN;
    sensors.obstacle_rear_cm = NAN;
    core.on_battery(80.0f);
    core.begin();
    motion.halt();  // BOOT_CREEP is off with CONFIRM_NAV_ENABLED: it waits
  }

  // ---- NavOutput ----
  void event(RobotEventType type, const char*, NodeIndex, const char*) override { events.push_back(type); }
  void halt() override { motion.halt(); }
  void brake() override { motion.brake(); }
  void follow_edge(NodeIndex from, NodeIndex to, EdgeDrive d) override {
    last_edge = std::string(GRAPH_NODES[from].id) + ">" + GRAPH_NODES[to].id;
    // The nav task reads millis() here, a little after the loop's `now`
    confirm.on_edge(from, to, d, now + 2);
    motion.follow_edge(from, to, d, now + 2);
  }
  void creep() override { motion.creep(now); }
  void jog(JogDirection d) override { motion.jog(d, now); }
  void drive(int16_t speed) override { motion.drive(speed, now); }
  void start_docking() override { motion.start_docking(now); }
  void note(const char* message) override { last_note = message; }

  // ---- Inputs ----
  // A node_reached, as the nav task handles one. True when taken.
  bool tap() {
    const char* why = "";
    NodeIndex n = confirm.reached(core.status(), now, &why);
    if (n == NO_NODE) {
      note(why);
      return false;
    }
    confirm.on_tag();
    core.on_tag(n, now);
    return true;
  }
  void command(CommandType type, const char* target = "") {
    Command c = {};
    c.type = type;
    strncpy(c.task_id, "t1", sizeof(c.task_id) - 1);
    strncpy(c.target_node, target, sizeof(c.target_node) - 1);
    c.action_at_target = type == CommandType::Navigate ? TargetAction::Idle : TargetAction::None;
    c.has_duration = true;
    c.duration_ms = 60000;
    c.priority = TaskPriority::Normal;
    c.source = CommandSource::Local;
    c.direction = JogDirection::Forward;
    core.on_command(c, now);
  }
  void tag(const char* node) {
    confirm.on_tag();
    core.on_tag(N(node), now);
  }
  // Nav loops of 20 ms for `ms`.
  void run(uint32_t ms) {
    for (uint32_t t = 0; t < ms; t += NAV_LOOP_MS) {
      now += NAV_LOOP_MS;
      core.tick(now);
      const char* fault = motion.check(now, sensors, false);
      if (fault) core.fault(fault);
      confirm.update(core.status(), motion.driving_edge());
    }
  }
  const char* node() const { return at(core.current_node()); }
  bool saw(RobotEventType type) const {
    for (RobotEventType e : events) if (e == type) return true;
    return false;
  }
};

static void test_boot() {
  SCENARIO("boot on the dock");
  Rig r;
  CHECK(r.core.status() == RobotStatus::Initializing);
  CHECK(r.tap());
  CHECK(r.core.status() == RobotStatus::Idle && same(r.node(), "dock-1"));
  // Idle: nothing to drive to
  r.run(2000);
  CHECK(!r.tap() && same(r.node(), "dock-1"));
}

static void test_route() {
  SCENARIO("navigate by taps");
  Rig r;
  r.tap();
  r.command(CommandType::Navigate, "water-01");
  CHECK(r.core.status() == RobotStatus::EnRoute && r.last_edge == "dock-1>cp-01");
  // Too soon after setting off: a double tap from the last node, or a repeat
  r.run(CONFIRM_NAV_MIN_MS / 2);
  CHECK(!r.tap() && same(r.node(), "dock-1"));
  r.run(CONFIRM_NAV_MIN_MS);
  CHECK(r.tap() && same(r.node(), "cp-01") && r.last_edge == "cp-01>water-01");
  // A second tap in the same loop (a duplicate delivery): not the next node
  CHECK(!r.tap() && same(r.node(), "cp-01"));
  r.run(CONFIRM_NAV_MIN_MS + 100);
  CHECK(r.tap() && same(r.node(), "water-01"));
  CHECK(r.core.status() == RobotStatus::Working && r.saw(RobotEventType::Arrived));
  // Working: nothing to drive to
  r.run(CONFIRM_NAV_MIN_MS + 100);
  CHECK(!r.tap() && same(r.node(), "water-01"));
}

static void test_elevator() {
  SCENARIO("elevator ride");
  Rig r;
  r.tap();
  r.command(CommandType::Navigate, "cp-11");
  for (const char* n : {"cp-01", "water-01", "cp-02", "elev-1-L0"}) {
    r.run(CONFIRM_NAV_MIN_MS + 100);
    CHECK(r.tap() && same(r.node(), n));
  }
  CHECK(r.last_edge == "elev-1-L0>elev-1-L1");
  // Onto the platform, then the ride: on the platform, not at the node
  r.run(CONFIRM_NAV_MIN_MS + 100);
  CHECK(!r.tap() && same(r.node(), "elev-1-L0"));
  r.sensors.obstacle_front_cm = ELEVATOR_STOP_CM;
  r.sensors.obstacle_rear_cm = ELEVATOR_STOP_CM;
  r.run(NAV_LOOP_MS * 2);  // stopped at the wall: riding
  r.sensors.obstacle_front_cm = NAN;
  r.sensors.obstacle_rear_cm = NAN;
  r.run(ELEVATOR_WAIT_MS / 2);
  CHECK(!r.tap() && same(r.node(), "elev-1-L0"));
  // Driving off at L1: that's the node it reaches
  r.run(ELEVATOR_WAIT_MS);
  CHECK(r.motion.driving_edge());
  CHECK(r.tap() && same(r.node(), "elev-1-L1") && r.last_edge == "elev-1-L1>cp-11");
  r.run(CONFIRM_NAV_MIN_MS + 100);
  CHECK(r.tap() && same(r.node(), "cp-11") && r.core.status() == RobotStatus::Working);
}

static void test_missed() {
  SCENARIO("missed node, then recovery");
  Rig r;
  r.tap();
  r.command(CommandType::Navigate, "water-01");
  // No tap: the missed-tag timeout faults, as for a missed tag
  r.run(MISSED_TAG_TIMEOUT_MS + 100);
  CHECK(r.core.status() == RobotStatus::Error && same(r.node(), "dock-1"));
  // Driven (or already) there: the node it was driving to
  CHECK(r.tap() && same(r.node(), "cp-01"));
  CHECK(r.saw(RobotEventType::Recovery));
  CHECK(r.core.status() == RobotStatus::EnRoute && r.last_edge == "cp-01>water-01");

  SCENARIO("missed node, driven there by hand");
  Rig j;
  j.tap();
  j.command(CommandType::Navigate, "water-01");
  j.run(MISSED_TAG_TIMEOUT_MS + 100);
  CHECK(j.core.status() == RobotStatus::Error);
  j.command(CommandType::Jog);
  CHECK(j.core.status() == RobotStatus::Manual);
  CHECK(j.tap() && same(j.node(), "cp-01"));
  // Manual times out: it carries on from there
  j.run(MANUAL_TIMEOUT_MS + 100);
  CHECK(j.core.status() == RobotStatus::EnRoute && j.last_edge == "cp-01>water-01");
}

static void test_stop_and_manual() {
  SCENARIO("stop, then resume keeps the time");
  Rig r;
  r.tap();
  r.command(CommandType::Navigate, "water-01");
  r.run(CONFIRM_NAV_MIN_MS / 2);
  r.command(CommandType::Stop);
  r.command(CommandType::Resume);
  CHECK(r.last_edge == "dock-1>cp-01");
  // The same node again: the time counts from setting off, not the resume
  r.run(CONFIRM_NAV_MIN_MS / 2 + 100);
  CHECK(r.tap() && same(r.node(), "cp-01"));

  SCENARIO("stopped at the node");
  Rig s;
  s.tap();
  s.command(CommandType::Navigate, "water-01");
  s.run(CONFIRM_NAV_MIN_MS + 100);
  s.command(CommandType::Stop);
  CHECK(s.tap() && same(s.node(), "cp-01") && s.core.status() == RobotStatus::Stopped);
  // Nothing more to reach until it drives again
  CHECK(!s.tap());
  s.command(CommandType::Resume);
  CHECK(s.core.status() == RobotStatus::EnRoute && s.last_edge == "cp-01>water-01");

  SCENARIO("driven there by hand");
  Rig m;
  m.tap();
  m.command(CommandType::Navigate, "water-01");
  m.run(CONFIRM_NAV_MIN_MS + 100);
  m.command(CommandType::Jog);
  CHECK(m.core.status() == RobotStatus::Manual);
  CHECK(m.tap() && same(m.node(), "cp-01") && m.core.status() == RobotStatus::Manual);
  m.run(MANUAL_TIMEOUT_MS + 100);
  CHECK(m.core.status() == RobotStatus::EnRoute && m.last_edge == "cp-01>water-01");

  SCENARIO("cancelled: nothing to reach");
  Rig c;
  c.tap();
  c.command(CommandType::Navigate, "water-01");
  c.run(CONFIRM_NAV_MIN_MS + 100);
  c.command(CommandType::Cancel);
  CHECK(c.core.status() == RobotStatus::Idle);
  CHECK(!c.tap() && same(c.node(), "dock-1"));
  // Not after a stop from there either
  c.run(NAV_LOOP_MS);
  c.command(CommandType::Stop);
  c.run(CONFIRM_NAV_MIN_MS + 100);
  CHECK(c.core.status() == RobotStatus::Stopped);
  CHECK(!c.tap() && same(c.node(), "dock-1"));
}

static void test_turned_back() {
  SCENARIO("turned back partway along an edge");
  Rig r;
  r.tap();
  r.command(CommandType::Navigate, "water-01");
  r.run(CONFIRM_NAV_MIN_MS + 100);
  CHECK(r.tap() && same(r.node(), "cp-01") && r.last_edge == "cp-01>water-01");
  // Halfway to water-01, back to the dock: planned from cp-01, which it
  // reaches first again
  r.run(CONFIRM_NAV_MIN_MS + 100);
  r.command(CommandType::ReturnToDock);
  CHECK(r.core.status() == RobotStatus::ReturningToDock && r.last_edge == "cp-01>dock-1");
  CHECK(r.tap() && same(r.node(), "cp-01") && r.core.status() == RobotStatus::ReturningToDock);
  CHECK(r.last_edge == "cp-01>dock-1");
  r.run(CONFIRM_NAV_MIN_MS + 100);
  CHECK(r.tap() && same(r.node(), "dock-1") && r.core.status() == RobotStatus::Docking);
}

static void test_real_tags() {
  SCENARIO("a real tag still works");
  Rig r;
  r.tap();
  r.command(CommandType::Navigate, "water-01");
  r.run(CONFIRM_NAV_MIN_MS + 100);
  r.tag("cp-01");
  CHECK(same(r.node(), "cp-01") && r.last_edge == "cp-01>water-01");
  // A tap straight after is for that node, not the next
  CHECK(!r.tap() && same(r.node(), "cp-01"));
}

int main() {
  test_boot();
  test_route();
  test_elevator();
  test_missed();
  test_stop_and_manual();
  test_turned_back();
  test_real_tags();
  printf("confirm_nav_test: %s\n", failures ? "FAILED" : "passed");
  return failures ? 1 : 0;
}
