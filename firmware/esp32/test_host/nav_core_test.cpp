// nav_core_test.cpp
// Drives the robot state machine (src/nav/nav_core) through command and
// sensor sequences on a laptop, against the farm graph (src/graph.cpp):
//
//   dock-1 - cp-01 - water-01 - cp-02 - elev-1-L0 = elev-1-L1 - cp-11 ...
//
// Throughout, it checks the contract rules that must always hold: idle never
// holds a task, and every event goes out while the robot still reports the
// status the event moves it out of (docs/firmware-architecture.md, events
// before telemetry).
//
// Built a second time with -DTIE_FIXTURE against fixtures/tie_topology.json
// for targets that can't be reached. Build + run with ./run.sh

#include <math.h>
#include <stdio.h>
#include <string.h>

#include <string>
#include <vector>

#include "comms/comms_json.h"
#include "config.h"
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

static NodeIndex N(const char* id) {
  NodeIndex n = node_by_id(id);
  if (n == NO_NODE) printf("  test bug: no node %s\n", id);
  return n;
}

// The status each event must be emitted in: the "from" side of its row in
// the transition table, since the status may only change after the event.
static bool emitted_before_transition(RobotEventType type, RobotStatus s) {
  switch (type) {
    case RobotEventType::Arrived:
      return s == RobotStatus::EnRoute || s == RobotStatus::ReturningToDock;
    case RobotEventType::TaskStarted: return s == RobotStatus::EnRoute;
    case RobotEventType::TaskComplete:
      return s == RobotStatus::Working || s == RobotStatus::Docking;
    case RobotEventType::DockConnected: return s == RobotStatus::Docking;
    case RobotEventType::ChargeComplete: return s == RobotStatus::Charging;
    case RobotEventType::Error: return s != RobotStatus::Error;
    case RobotEventType::Recovery: return s == RobotStatus::Error || s == RobotStatus::Manual;
    case RobotEventType::BatteryCritical:
      return s != RobotStatus::ReturningToDock && s != RobotStatus::Docking &&
             s != RobotStatus::Charging;
    default: return true;
  }
}

struct Event {
  RobotEventType type;
  std::string task_id;
  std::string node;
  RobotStatus status_at_emit;
};

class Rig : public NavOutput {
 public:
  NavCore core{*this};
  uint32_t now = 1000;
  std::vector<Event> events;
  std::vector<std::string> motion;  // "halt", "edge a>b", "creep", "jog f", "dock"

  Rig() { core.on_battery(80.0f); }

  // Boots and localizes at `node`.
  void boot_at(const char* node) {
    core.begin();
    tag(node);
    clear();
  }

  void clear() {
    events.clear();
    motion.clear();
  }

  // ---- NavOutput ----
  void event(RobotEventType type, const char* task_id, NodeIndex node, const char*) override {
    CHECK(emitted_before_transition(type, core.status()));
    events.push_back({type, task_id, node == NO_NODE ? "" : GRAPH_NODES[node].id, core.status()});
  }
  void halt() override { motion.push_back("halt"); }
  void follow_edge(NodeIndex from, NodeIndex to, bool, Heading) override {
    motion.push_back(std::string("edge ") + GRAPH_NODES[from].id + ">" + GRAPH_NODES[to].id);
  }
  void creep() override { motion.push_back("creep"); }
  void jog(JogDirection d) override { motion.push_back(d == JogDirection::Backward ? "jog b" : "jog f"); }
  void start_docking() override { motion.push_back("dock"); }
  void note(const char*) override {}

  // ---- Inputs ----
  void command(const Command& c) {
    core.on_command(c, now);
    after_step();
  }
  void tag(const char* node) {
    core.on_tag(node ? N(node) : NO_NODE, now);
    after_step();
  }
  void advance(uint32_t ms) {
    now += ms;
    core.tick(now);
    after_step();
  }
  void battery(float pct) { core.on_battery(pct); }
  void contact() {
    core.on_charge_contact();
    after_step();
  }
  // Drives the path by reading each tag in turn.
  void drive(std::initializer_list<const char*> nodes) {
    for (const char* n : nodes) tag(n);
  }

  // ---- State ----
  RobotStatus status() const { return core.status(); }
  std::string task() const { return core.reported_task_id(); }
  std::string node() const {
    return core.current_node() == NO_NODE ? "" : GRAPH_NODES[core.current_node()].id;
  }
  std::string last_completed() const { return core.context().last_completed_task_id; }
  bool latched() const { return core.context().stop_latched; }
  std::string last_motion() const { return motion.empty() ? "" : motion.back(); }

  // Events of the given types, in order, and nothing else since clear().
  bool emitted(std::initializer_list<RobotEventType> types) const {
    if (events.size() != types.size()) return false;
    size_t i = 0;
    for (RobotEventType t : types) {
      if (events[i++].type != t) return false;
    }
    return true;
  }
  const Event& last_event() const { return events.back(); }

 private:
  void after_step() {
    if (core.status() == RobotStatus::Idle) CHECK(task().empty());
  }
};

static Command make(CommandType type, const char* task_id = "") {
  Command c = {};
  c.type = type;
  strncpy(c.task_id, task_id, sizeof(c.task_id) - 1);
  c.priority = TaskPriority::Normal;
  c.source = CommandSource::Local;
  return c;
}

static Command navigate(const char* task_id, const char* target, TargetAction action,
                        long duration_ms = -1) {
  Command c = make(CommandType::Navigate, task_id);
  strncpy(c.target_node, target, sizeof(c.target_node) - 1);
  c.action_at_target = action;
  c.has_duration = duration_ms >= 0;
  c.duration_ms = duration_ms >= 0 ? (uint32_t)duration_ms : 0;
  return c;
}

#define SCENARIO(name) g_scenario = name;

// ---- Scenarios -------------------------------------------------------------------

#ifndef TIE_FIXTURE

static Command with_path(Command c, std::initializer_list<const char*> path) {
  for (const char* p : path) strncpy(c.path[c.path_len++], p, NODE_ID_LEN - 1);
  return c;
}

static Command jog(JogDirection d) {
  Command c = make(CommandType::Jog);
  c.direction = d;
  return c;
}

static void test_boot() {
  SCENARIO("boot");
  Rig r;
  r.core.begin();
  CHECK(r.status() == RobotStatus::Initializing);
  CHECK(r.last_motion() == "creep");
  // Nothing is acted on before the robot knows where it is.
  r.command(navigate("t1", "water-01", TargetAction::Water, 1000));
  r.command(jog(JogDirection::Forward));
  r.command(make(CommandType::ReturnToDock, "d1"));
  r.command(make(CommandType::Stop));
  CHECK(r.status() == RobotStatus::Initializing && r.events.empty());
  r.tag(nullptr);  // a tag that isn't in the graph
  CHECK(r.status() == RobotStatus::Initializing);
  r.tag("cp-01");
  CHECK(r.status() == RobotStatus::Idle && r.node() == "cp-01" && r.events.empty());
  CHECK(r.last_motion() == "halt");
  TelemetryMsg t = {};
  r.core.snapshot(t);
  CHECK(!t.heading_known);  // no move yet
}

static void test_task_cycle() {
  SCENARIO("navigate, work, complete");
  Rig r;
  r.boot_at("dock-1");
  r.command(navigate("t1", "cp-02", TargetAction::Water, 5000));
  CHECK(r.status() == RobotStatus::EnRoute && r.task() == "t1");
  CHECK(r.last_motion() == "edge dock-1>cp-01");
  r.drive({"cp-01", "water-01"});
  CHECK(r.status() == RobotStatus::EnRoute && r.last_motion() == "edge water-01>cp-02");
  r.tag("cp-02");
  CHECK(r.status() == RobotStatus::Working);
  CHECK(r.emitted({RobotEventType::Arrived, RobotEventType::TaskStarted}));
  CHECK(r.last_event().task_id == "t1" && r.last_event().node == "cp-02");
  r.clear();
  r.advance(4999);
  CHECK(r.status() == RobotStatus::Working && r.events.empty());
  r.advance(1);
  CHECK(r.emitted({RobotEventType::TaskComplete}));
  CHECK(r.last_event().task_id == "t1" && r.last_event().status_at_emit == RobotStatus::Working);
  CHECK(r.status() == RobotStatus::Idle && r.task().empty() && r.last_completed() == "t1");
  TelemetryMsg t = {};
  r.core.snapshot(t);
  CHECK(t.heading_known && t.heading == Heading::East);
  CHECK(strcmp(t.current_node, "cp-02") == 0 && t.task_id[0] == '\0');
  CHECK(strcmp(t.last_completed_task_id, "t1") == 0);
}

static void test_navigate_edge_cases() {
  SCENARIO("navigate edge cases");
  Rig r;
  r.boot_at("water-01");

  // Already at the target: arrives straight away.
  r.command(navigate("t1", "water-01", TargetAction::Water, 1000));
  CHECK(r.status() == RobotStatus::Working);
  CHECK(r.emitted({RobotEventType::Arrived, RobotEventType::TaskStarted}));
  r.advance(1000);
  CHECK(r.status() == RobotStatus::Idle && r.last_completed() == "t1");

  // Redelivered: the last completed task, then the task in hand.
  r.clear();
  r.command(navigate("t1", "cp-02", TargetAction::Water, 1000));
  CHECK(r.status() == RobotStatus::Idle && r.events.empty() && r.motion.empty());
  r.command(navigate("t2", "cp-02", TargetAction::Water, 1000));
  r.clear();
  r.command(navigate("t2", "cp-01", TargetAction::Water, 1000));
  CHECK(r.status() == RobotStatus::EnRoute && r.motion.empty() && r.events.empty());
  r.tag("cp-02");
  r.advance(1000);
  CHECK(r.status() == RobotStatus::Idle && r.last_completed() == "t2");

  // Unknown target: task_failed with the command's id, state unchanged.
  r.clear();
  r.command(navigate("t3", "nowhere", TargetAction::Water, 1000));
  CHECK(r.emitted({RobotEventType::TaskFailed}) && r.last_event().task_id == "t3");
  CHECK(r.status() == RobotStatus::Idle && r.last_completed() == "t2");

  // "idle" with no duration completes right after it starts.
  r.clear();
  r.command(navigate("t4", "cp-02", TargetAction::Idle));
  CHECK(r.emitted({RobotEventType::Arrived, RobotEventType::TaskStarted,
                   RobotEventType::TaskComplete}));
  CHECK(r.status() == RobotStatus::Idle && r.last_completed() == "t4");

  // No duration: the per-action default from config.h.
  r.command(navigate("t5", "cp-02", TargetAction::Water));
  r.advance(DEFAULT_WATER_MS - 1);
  CHECK(r.status() == RobotStatus::Working);
  r.advance(1);
  CHECK(r.status() == RobotStatus::Idle);

  // A navigate replaces a task in hand (no event for the old one).
  r.command(navigate("t6", "dock-1", TargetAction::Water, 1000));
  r.clear();
  r.command(navigate("t7", "cp-11", TargetAction::Grow, 1000));
  CHECK(r.task() == "t7" && r.events.empty());
}

static void test_command_path() {
  SCENARIO("navigate with a path");
  Rig r;
  r.boot_at("cp-01");
  // Planned from an older position: followed from the robot's node on.
  r.command(with_path(navigate("t1", "cp-02", TargetAction::Water, 10),
                      {"dock-1", "cp-01", "water-01", "cp-02"}));
  CHECK(r.status() == RobotStatus::EnRoute && r.last_motion() == "edge cp-01>water-01");

  // Not a drivable path (skips water-01): planned on board instead.
  Rig r2;
  r2.boot_at("cp-01");
  r2.command(with_path(navigate("t1", "cp-02", TargetAction::Water, 10),
                       {"cp-01", "cp-02"}));
  CHECK(r2.status() == RobotStatus::EnRoute && r2.last_motion() == "edge cp-01>water-01");

  // Ends somewhere else, or names an unknown node: planned on board.
  Rig r3;
  r3.boot_at("cp-01");
  r3.command(with_path(navigate("t1", "cp-02", TargetAction::Water, 10),
                       {"cp-01", "dock-1"}));
  CHECK(r3.last_motion() == "edge cp-01>water-01");
  Rig r4;
  r4.boot_at("cp-01");
  r4.command(with_path(navigate("t1", "dock-1", TargetAction::Water, 10), {"cp-01", "bogus"}));
  CHECK(r4.last_motion() == "edge cp-01>dock-1");
}

static void test_path_following() {
  SCENARIO("path following");
  Rig r;
  r.boot_at("dock-1");
  r.command(navigate("t1", "elev-1-L0", TargetAction::Water, 10));
  // A missed tag: the next one along the path still counts.
  r.tag("water-01");
  CHECK(r.status() == RobotStatus::EnRoute && r.last_motion() == "edge water-01>cp-02");
  // Off the path (pushed back): re-plan from there.
  r.tag("cp-01");
  CHECK(r.status() == RobotStatus::EnRoute && r.last_motion() == "edge cp-01>water-01");
  // The same tag read again: keep going.
  r.tag("cp-01");
  CHECK(r.last_motion() == "edge cp-01>water-01");
  // Elevator move: the heading stays.
  r.drive({"water-01", "cp-02", "elev-1-L0"});
  CHECK(r.status() == RobotStatus::Working);
  r.advance(10);
  r.command(navigate("t2", "elev-1-L1", TargetAction::Water, 10));
  TelemetryMsg t = {};
  r.core.snapshot(t);
  CHECK(t.heading_known && t.heading == Heading::East);
}

static void test_stop_resume() {
  SCENARIO("stop and resume");
  Rig r;
  r.boot_at("dock-1");
  r.command(make(CommandType::Resume));  // no stop: ignored
  CHECK(r.status() == RobotStatus::Idle);

  r.command(navigate("t1", "water-01", TargetAction::Water, 10000));
  r.tag("cp-01");
  r.clear();
  r.command(make(CommandType::Stop));
  CHECK(r.status() == RobotStatus::Stopped && r.task() == "t1" && r.latched());
  CHECK(r.last_motion() == "halt" && r.events.empty());
  r.command(make(CommandType::Stop));  // already stopped
  CHECK(r.status() == RobotStatus::Stopped);
  r.command(make(CommandType::Resume));
  CHECK(r.status() == RobotStatus::EnRoute && !r.latched());
  CHECK(r.last_motion() == "edge cp-01>water-01");

  // Stop while working holds the action timer.
  r.tag("water-01");
  r.advance(4000);
  r.command(make(CommandType::Stop));
  r.advance(100000);
  CHECK(r.status() == RobotStatus::Stopped);
  r.command(make(CommandType::Resume));
  CHECK(r.status() == RobotStatus::Working);
  r.advance(5999);
  CHECK(r.status() == RobotStatus::Working);
  r.advance(1);
  CHECK(r.status() == RobotStatus::Idle && r.last_completed() == "t1");

  // Stop while idle (the orchestrator's queued stop): resume goes back to idle.
  r.command(make(CommandType::Stop));
  CHECK(r.status() == RobotStatus::Stopped);
  r.command(make(CommandType::Resume));
  CHECK(r.status() == RobotStatus::Idle);

  // Moved while stopped: resume re-plans from where it is.
  r.command(navigate("t2", "cp-02", TargetAction::Water, 10000));
  r.command(make(CommandType::Stop));
  r.tag("dock-1");
  CHECK(r.status() == RobotStatus::Stopped && r.node() == "dock-1");
  r.command(make(CommandType::Resume));
  CHECK(r.last_motion() == "edge dock-1>cp-01");
}

static void test_dock_trip_keeps_task() {
  SCENARIO("return_to_dock keeps the task");
  Rig r;
  r.boot_at("cp-01");
  r.command(navigate("t1", "cp-02", TargetAction::Water, 1000));
  r.tag("water-01");
  r.clear();
  r.command(make(CommandType::ReturnToDock));
  CHECK(r.status() == RobotStatus::ReturningToDock && r.task() == "t1");
  CHECK(r.last_motion() == "edge water-01>cp-01" && r.events.empty());
  r.command(make(CommandType::ReturnToDock));  // already returning
  CHECK(r.status() == RobotStatus::ReturningToDock);
  // A redelivered navigate for the kept task is a duplicate.
  r.command(navigate("t1", "cp-02", TargetAction::Water, 1000));
  CHECK(r.status() == RobotStatus::ReturningToDock);
  r.drive({"cp-01", "dock-1"});
  CHECK(r.emitted({RobotEventType::Arrived}) && r.last_event().task_id == "t1");
  CHECK(r.status() == RobotStatus::Docking && r.last_motion() == "dock");
  r.clear();
  r.contact();
  CHECK(r.emitted({RobotEventType::DockConnected}));
  CHECK(r.status() == RobotStatus::Charging && r.task() == "t1");
  r.battery(CHARGE_COMPLETE_PCT - 0.1f);
  r.advance(1000);
  CHECK(r.status() == RobotStatus::Charging);
  r.clear();
  r.battery(CHARGE_COMPLETE_PCT);
  r.advance(1000);
  CHECK(r.emitted({RobotEventType::ChargeComplete}));
  CHECK(r.last_event().status_at_emit == RobotStatus::Charging);
  CHECK(r.status() == RobotStatus::EnRoute && r.task() == "t1");
  CHECK(r.last_motion() == "edge dock-1>cp-01");
  r.drive({"cp-01", "water-01", "cp-02"});
  CHECK(r.status() == RobotStatus::Working);
}

static void test_dock_task() {
  SCENARIO("dock task");
  Rig r;
  r.boot_at("water-01");
  r.command(make(CommandType::ReturnToDock, "d1"));
  CHECK(r.status() == RobotStatus::ReturningToDock && r.task() == "d1");
  r.drive({"cp-01", "dock-1"});
  r.clear();
  r.contact();
  CHECK(r.emitted({RobotEventType::DockConnected, RobotEventType::TaskComplete}));
  CHECK(r.last_event().task_id == "d1");
  CHECK(r.status() == RobotStatus::Charging && r.task().empty() && r.last_completed() == "d1");
  r.battery(100);
  r.advance(10);
  CHECK(r.status() == RobotStatus::Idle);

  // Already at the dock: the dock sequence runs again, no driving.
  r.clear();
  r.command(make(CommandType::ReturnToDock, "d2"));
  CHECK(r.status() == RobotStatus::Docking && r.last_motion() == "dock" && r.task() == "d2");
  // Contact only counts while docking.
  Rig r2;
  r2.boot_at("dock-1");
  r2.contact();
  CHECK(r2.status() == RobotStatus::Idle && r2.events.empty());
}

static void test_stop_latch_through_dock_trip() {
  SCENARIO("stop latch survives a dock trip");
  Rig r;
  r.boot_at("cp-01");
  r.command(navigate("t1", "cp-02", TargetAction::Water, 1000));
  r.command(make(CommandType::Stop));
  r.clear();
  r.core.survival_return("14.0%", r.now);
  CHECK(r.emitted({RobotEventType::BatteryCritical}));
  CHECK(r.last_event().status_at_emit == RobotStatus::Stopped);
  CHECK(r.status() == RobotStatus::ReturningToDock && r.latched() && r.task() == "t1");
  r.core.survival_return("13.0%", r.now);  // already returning: nothing
  CHECK(r.events.size() == 1);
  r.tag("dock-1");
  r.contact();
  r.battery(96);
  r.advance(10);
  CHECK(r.status() == RobotStatus::Stopped && r.task() == "t1");
  r.command(make(CommandType::Resume));
  CHECK(r.status() == RobotStatus::EnRoute && r.task() == "t1");

  // Resume during the trip: it carries on after charging instead.
  Rig r2;
  r2.boot_at("cp-01");
  r2.command(navigate("t1", "cp-02", TargetAction::Water, 1000));
  r2.command(make(CommandType::Stop));
  r2.core.survival_return("14.0%", r2.now);
  r2.command(make(CommandType::Resume));
  CHECK(r2.status() == RobotStatus::ReturningToDock && !r2.latched());
  r2.tag("dock-1");
  r2.contact();
  r2.battery(96);
  r2.advance(10);
  CHECK(r2.status() == RobotStatus::EnRoute && r2.task() == "t1");
}

static void test_cancel() {
  SCENARIO("cancel");
  Rig r;
  r.boot_at("dock-1");
  r.command(navigate("t1", "cp-02", TargetAction::Water, 1000));
  r.clear();
  r.command(make(CommandType::Cancel, "other"));
  CHECK(r.status() == RobotStatus::EnRoute && r.task() == "t1");
  r.command(make(CommandType::Cancel, "t1"));
  CHECK(r.status() == RobotStatus::Idle && r.events.empty() && r.last_completed().empty());
  CHECK(r.last_motion() == "halt");

  // A paused task: stays stopped, resumes to idle.
  r.command(navigate("t2", "cp-02", TargetAction::Water, 1000));
  r.command(make(CommandType::Stop));
  r.command(make(CommandType::Cancel, "t2"));
  CHECK(r.status() == RobotStatus::Stopped && r.task().empty());
  r.command(make(CommandType::Resume));
  CHECK(r.status() == RobotStatus::Idle);

  // The kept task: the dock trip carries on, then idle.
  r.command(navigate("t3", "cp-02", TargetAction::Water, 1000));
  r.tag("cp-01");
  r.command(make(CommandType::ReturnToDock));
  r.command(make(CommandType::Cancel, "t3"));
  CHECK(r.status() == RobotStatus::ReturningToDock && r.task().empty());
  r.tag("dock-1");
  r.contact();
  r.battery(96);
  r.clear();
  r.advance(10);
  CHECK(r.status() == RobotStatus::Idle && r.emitted({RobotEventType::ChargeComplete}));

  // A dock task: the trip stops.
  r.tag("cp-01");
  r.command(make(CommandType::ReturnToDock, "d1"));
  r.command(make(CommandType::Cancel, "d1"));
  CHECK(r.status() == RobotStatus::Idle && r.task().empty());
}

static void test_manual() {
  SCENARIO("manual");
  Rig r;
  r.boot_at("dock-1");
  r.command(navigate("t1", "cp-02", TargetAction::Water, 1000));
  r.tag("cp-01");
  r.clear();
  r.command(jog(JogDirection::Forward));
  CHECK(r.status() == RobotStatus::Manual && r.task() == "t1" && r.last_motion() == "jog f");
  CHECK(r.events.empty());
  // Each jog restarts the timeout.
  r.advance(MANUAL_TIMEOUT_MS - 1);
  r.command(jog(JogDirection::Backward));
  CHECK(r.core.reversing());
  r.advance(MANUAL_TIMEOUT_MS - 1);
  CHECK(r.status() == RobotStatus::Manual);
  // Reversing over a tag: the heading doesn't change.
  r.tag("dock-1");
  TelemetryMsg t = {};
  r.core.snapshot(t);
  CHECK(t.heading == Heading::East);
  // Timeout: re-plan from the last tag read and continue the task, even if
  // the robot was left a little past it.
  r.advance(1);
  CHECK(r.status() == RobotStatus::EnRoute && r.task() == "t1" && r.node() == "dock-1");
  CHECK(r.last_motion() == "edge dock-1>cp-01");

  // From working: the action restarts on arrival.
  r.drive({"water-01", "cp-02"});
  r.advance(900);
  r.command(jog(JogDirection::Forward));
  r.clear();
  r.command(make(CommandType::Resume));
  CHECK(r.emitted({RobotEventType::Arrived, RobotEventType::TaskStarted}));
  r.advance(999);
  CHECK(r.status() == RobotStatus::Working);
  r.advance(1);
  CHECK(r.status() == RobotStatus::Idle);

  // From stopped: a timeout gives it back stopped; resume continues the task.
  r.command(navigate("t2", "dock-1", TargetAction::Water, 1000));
  r.command(make(CommandType::Stop));
  r.command(jog(JogDirection::Forward));
  r.advance(MANUAL_TIMEOUT_MS);
  CHECK(r.status() == RobotStatus::Stopped && r.latched() && r.task() == "t2");
  r.command(jog(JogDirection::Forward));
  r.command(make(CommandType::Resume));
  CHECK(r.status() == RobotStatus::EnRoute && !r.latched() && r.task() == "t2");

  // Nothing to do: idle. Not allowed on a dock trip or at the motor cutoff.
  r.command(make(CommandType::Cancel, "t2"));
  r.command(jog(JogDirection::Forward));
  r.advance(MANUAL_TIMEOUT_MS);
  CHECK(r.status() == RobotStatus::Idle);
  r.command(make(CommandType::ReturnToDock));
  r.command(jog(JogDirection::Forward));
  CHECK(r.status() == RobotStatus::ReturningToDock);
  Rig r2;
  r2.boot_at("cp-01");
  r2.battery(BATTERY_CUTOFF_PCT);
  r2.command(jog(JogDirection::Forward));
  CHECK(r2.status() == RobotStatus::Idle);
  // Battery forced return doesn't apply while an operator drives.
  r2.battery(50);
  r2.command(jog(JogDirection::Forward));
  r2.core.survival_return("14.0%", r2.now);
  CHECK(r2.status() == RobotStatus::Manual && r2.events.empty());
}

static void test_fault_recovery() {
  SCENARIO("fault and recovery");
  Rig r;
  r.boot_at("dock-1");
  r.command(navigate("t1", "cp-02", TargetAction::Water, 1000));
  r.clear();
  r.core.fault("missed tag");
  CHECK(r.emitted({RobotEventType::Error}) && r.last_event().task_id == "t1");
  CHECK(r.status() == RobotStatus::Error && r.task() == "t1" && r.node() == "dock-1");
  r.core.fault("again");  // already in error
  CHECK(r.events.size() == 1);
  r.clear();
  r.tag("water-01");
  CHECK(r.emitted({RobotEventType::Recovery}));
  CHECK(r.last_event().status_at_emit == RobotStatus::Error);
  CHECK(r.status() == RobotStatus::EnRoute && r.last_motion() == "edge water-01>cp-02");

  // Manual from error: recovery on leaving manual, then the interrupted dock
  // trip continues from the last tag.
  Rig r2;
  r2.boot_at("cp-01");
  r2.command(make(CommandType::ReturnToDock));
  r2.core.fault("missed tag");
  r2.command(make(CommandType::Cancel, "x"));
  r2.command(jog(JogDirection::Forward));
  r2.clear();
  r2.command(make(CommandType::Resume));
  CHECK(r2.emitted({RobotEventType::Recovery}));
  CHECK(r2.status() == RobotStatus::ReturningToDock);

  // No tag found after boot: stops looking, still initializing.
  Rig r3;
  r3.core.begin();
  r3.core.fault("no tag found");
  CHECK(r3.emitted({RobotEventType::Error}) && r3.last_motion() == "halt");
  CHECK(r3.status() == RobotStatus::Initializing);
  r3.tag("cp-01");
  CHECK(r3.status() == RobotStatus::Idle);

  // An operator is driving: no fault applies.
  r3.command(navigate("t1", "cp-02", TargetAction::Water, 1000));
  r3.command(jog(JogDirection::Forward));
  r3.clear();
  r3.core.fault("missed tag");
  CHECK(r3.status() == RobotStatus::Manual && r3.events.empty());
}

int main() {
  test_boot();
  test_task_cycle();
  test_navigate_edge_cases();
  test_command_path();
  test_path_following();
  test_stop_resume();
  test_dock_trip_keeps_task();
  test_dock_task();
  test_stop_latch_through_dock_trip();
  test_cancel();
  test_manual();
  test_fault_recovery();
  printf("nav_core_test: %s\n", failures ? "FAILED" : "passed");
  return failures ? 1 : 0;
}

#else

// Against fixtures/tie_topology.json, where "oneway" can be reached from
// "c1" but leads nowhere.
static void test_unreachable() {
  SCENARIO("unreachable targets");
  Rig r;
  r.boot_at("oneway");
  r.command(navigate("t1", "c1", TargetAction::Water, 1000));
  CHECK(r.emitted({RobotEventType::TaskFailed}) && r.last_event().task_id == "t1");
  CHECK(r.status() == RobotStatus::Idle);
  r.clear();
  r.command(make(CommandType::ReturnToDock, "d1"));
  CHECK(r.emitted({RobotEventType::TaskFailed}) && r.last_event().task_id == "d1");
  CHECK(r.status() == RobotStatus::Idle);

  // Knocked onto the dead end mid-task: the path can't be followed, so the
  // task fails and the robot goes idle without it.
  Rig r2;
  r2.boot_at("c1");
  r2.command(navigate("t2", "b2", TargetAction::Water, 1000));
  r2.clear();
  r2.tag("oneway");
  CHECK(r2.emitted({RobotEventType::TaskFailed}) && r2.last_event().task_id == "t2");
  CHECK(r2.status() == RobotStatus::Idle && r2.task().empty());

  // The same during a dock trip with a kept task: both fail.
  Rig r3;
  r3.boot_at("b1");
  r3.command(navigate("t3", "c2", TargetAction::Water, 1000));
  r3.tag("c1");
  r3.command(make(CommandType::ReturnToDock));
  r3.clear();
  r3.tag("oneway");
  CHECK(r3.emitted({RobotEventType::TaskFailed}) && r3.last_event().task_id == "t3");
  CHECK(r3.status() == RobotStatus::Idle);

  // A disconnected node is never a target.
  r3.tag("far");
  r3.command(navigate("t4", "dock", TargetAction::Water, 1000));
  CHECK(r3.status() == RobotStatus::Idle && r3.last_event().task_id == "t4");
}

int main() {
  test_unreachable();
  printf("nav_core_test (fixture): %s\n", failures ? "FAILED" : "passed");
  return failures ? 1 : 0;
}

#endif
