// survival_test.cpp
// Drives the survival overrides (src/nav/survival) with a real NavCore on a
// laptop, against the farm graph (src/graph.cpp):
//
//   dock-1 - cp-01 - water-01 - cp-02 ...
//
// Battery thresholds in each status (a stop beats the forced return; only
// the motor cutoff applies to a stopped robot), and the obstacle events.
// Build + run with ./run.sh

#include <math.h>
#include <stdio.h>
#include <string.h>

#include <vector>

#include "config.h"
#include "nav/nav_core.h"
#include "nav/survival.h"
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

class Rig : public NavOutput {
 public:
  NavCore core{*this};
  Survival survival{core};
  uint32_t now = 1000;
  std::vector<RobotEventType> events;
  bool killed = false;

  // Boots at cp-01 and heads for water-01 (en_route).
  void en_route() {
    core.on_battery(80.0f);
    core.begin();
    core.on_tag(N("cp-01"), now);
    Command c = make(CommandType::Navigate, "t1");
    strncpy(c.target_node, "water-01", sizeof(c.target_node) - 1);
    c.action_at_target = TargetAction::Water;
    core.on_command(c, now);
    events.clear();
  }

  // One nav loop's survival check.
  void check(float battery_pct, bool blocked = false, uint32_t ms = NAV_LOOP_MS) {
    now += ms;
    core.on_battery(battery_pct);
    killed = survival.check(battery_pct, blocked, now);
  }
  void command(CommandType type) { core.on_command(make(type, ""), now); }
  void jog() {
    Command c = make(CommandType::Jog, "");
    c.direction = JogDirection::Forward;
    core.on_command(c, now);
  }

  int count(RobotEventType type) const {
    int n = 0;
    for (RobotEventType t : events) n += t == type;
    return n;
  }
  RobotStatus status() const { return core.status(); }

  // ---- NavOutput ----
  void event(RobotEventType type, const char*, NodeIndex, const char*) override {
    events.push_back(type);
  }
  void halt() override {}
  void follow_edge(NodeIndex, NodeIndex, EdgeDrive) override {}
  void creep() override {}
  void jog(JogDirection) override {}
  void start_docking() override {}
  void note(const char*) override {}

 private:
  static Command make(CommandType type, const char* task_id) {
    Command c = {};
    c.type = type;
    strncpy(c.task_id, task_id, sizeof(c.task_id) - 1);
    c.priority = TaskPriority::Normal;
    c.source = CommandSource::Local;
    return c;
  }
};

static void test_warn() {
  SCENARIO("battery_low");
  Rig r;
  r.en_route();
  r.check(NAN);
  r.check(BATTERY_WARN_PCT + 1);
  CHECK(r.events.empty());
  r.check(BATTERY_WARN_PCT);
  r.check(BATTERY_WARN_PCT - 1);
  CHECK(r.count(RobotEventType::BatteryLow) == 1 && r.events.size() == 1);
  CHECK(r.status() == RobotStatus::EnRoute && !r.killed);
  // Charged up: it can warn again.
  r.check(CHARGE_COMPLETE_PCT);
  r.check(BATTERY_WARN_PCT);
  CHECK(r.count(RobotEventType::BatteryLow) == 2);
}

static void test_forced_return() {
  SCENARIO("forced return");
  Rig r;
  r.en_route();
  r.check(BATTERY_RETURN_PCT);
  CHECK(r.count(RobotEventType::BatteryCritical) == 1);
  CHECK(r.status() == RobotStatus::ReturningToDock);
  CHECK(strcmp(r.core.reported_task_id(), "t1") == 0);  // kept
  r.check(BATTERY_RETURN_PCT - 1);
  CHECK(r.count(RobotEventType::BatteryCritical) == 1);

  // Charging below the return level: nothing more to do.
  r.core.on_tag(N("dock-1"), r.now);
  CHECK(r.status() == RobotStatus::Docking);
  r.core.on_charge_contact();
  CHECK(r.status() == RobotStatus::Charging);
  r.events.clear();
  r.check(BATTERY_RETURN_PCT - 1);
  CHECK(r.events.empty() && r.status() == RobotStatus::Charging);
}

static void test_stop_beats_return() {
  SCENARIO("stop beats the forced return");
  Rig r;
  r.en_route();
  r.command(CommandType::Stop);
  r.check(BATTERY_RETURN_PCT - 1);
  CHECK(r.status() == RobotStatus::Stopped && r.count(RobotEventType::BatteryCritical) == 0);
  // Resumed: the forced return applies again.
  r.command(CommandType::Resume);
  r.check(BATTERY_RETURN_PCT - 1);
  CHECK(r.status() == RobotStatus::ReturningToDock);
  CHECK(r.count(RobotEventType::BatteryCritical) == 1);
}

static void test_cutoff() {
  SCENARIO("motor cutoff");
  Rig r;
  r.en_route();
  r.check(BATTERY_CUTOFF_PCT);
  CHECK(r.killed && r.status() == RobotStatus::Error);
  CHECK(r.count(RobotEventType::Error) == 1);
  CHECK(r.count(RobotEventType::BatteryCritical) == 0);  // can't drive to the dock
  CHECK(strcmp(r.core.reported_task_id(), "t1") == 0);
  // Stays off through noise near the cutoff, until above the return level.
  r.check(BATTERY_CUTOFF_PCT + 3);
  r.check(BATTERY_RETURN_PCT);
  CHECK(r.killed && r.count(RobotEventType::Error) == 1);
  r.check(BATTERY_RETURN_PCT + 1);
  CHECK(!r.killed);

  // Stopped: motors off, status kept. Resumed: error rather than waiting.
  Rig s;
  s.en_route();
  s.command(CommandType::Stop);
  s.check(BATTERY_CUTOFF_PCT - 1);
  CHECK(s.killed && s.status() == RobotStatus::Stopped);
  s.command(CommandType::Resume);
  s.check(BATTERY_CUTOFF_PCT - 1);
  CHECK(s.killed && s.status() == RobotStatus::Error);

  // Initializing: one error event, not one per loop.
  Rig b;
  b.core.begin();
  b.check(BATTERY_CUTOFF_PCT - 1);
  b.check(BATTERY_CUTOFF_PCT - 1);
  CHECK(b.killed && b.count(RobotEventType::Error) == 1);
  CHECK(b.status() == RobotStatus::Initializing);

  // Charging: motors off, but it carries on charging, with no battery_low.
  Rig c;
  c.en_route();
  c.command(CommandType::ReturnToDock);
  c.core.on_tag(N("dock-1"), c.now);
  c.core.on_charge_contact();
  c.events.clear();
  c.check(BATTERY_CUTOFF_PCT - 1);
  CHECK(c.killed && c.status() == RobotStatus::Charging && c.events.empty());
}

static void test_obstacle() {
  SCENARIO("obstacle");
  Rig r;
  r.en_route();
  r.check(80, true);
  CHECK(r.count(RobotEventType::ObstacleDetected) == 1 && r.events.size() == 1);
  r.check(80, true, PATH_BLOCKED_TIMEOUT_MS - 2 * NAV_LOOP_MS);
  CHECK(r.count(RobotEventType::PathBlocked) == 0);
  r.check(80, true);
  r.check(80, true, PATH_BLOCKED_TIMEOUT_MS);
  CHECK(r.count(RobotEventType::PathBlocked) == 1 && r.events.size() == 2);
  CHECK(r.status() == RobotStatus::EnRoute && !r.killed);  // status kept
  // Cleared, then blocked again: a new obstacle.
  r.check(80, false);
  r.check(80, true);
  CHECK(r.count(RobotEventType::ObstacleDetected) == 2);

  // Not driving itself: nothing to report.
  Rig s;
  s.en_route();
  s.command(CommandType::Stop);
  s.check(80, true, PATH_BLOCKED_TIMEOUT_MS * 2);
  CHECK(s.count(RobotEventType::ObstacleDetected) == 0);

  // Jogged into it: reported, so the operator knows why it stopped.
  Rig m;
  m.en_route();
  m.jog();
  m.check(80, true);
  CHECK(m.status() == RobotStatus::Manual);
  CHECK(m.count(RobotEventType::ObstacleDetected) == 1);
  // Parked in manual after the pulse, obstacle still there: nothing new.
  m.check(80, false);
  m.check(80, true, JOG_PULSE_MS);
  CHECK(m.count(RobotEventType::ObstacleDetected) == 1);
}

int main() {
  test_warn();
  test_forced_return();
  test_stop_beats_return();
  test_cutoff();
  test_obstacle();
  printf("survival_test: %s\n", failures ? "FAILED" : "passed");
  return failures ? 1 : 0;
}
