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
      return s == RobotStatus::Working || s == RobotStatus::Docking ||
             s == RobotStatus::ReturningToDock;
    case RobotEventType::DockConnected:  // idle or stopped: a bench charge (charge_sense_always)
      return s == RobotStatus::Docking || s == RobotStatus::Idle || s == RobotStatus::Stopped;
    case RobotEventType::ChargeComplete:  // the charge_complete command ends any dock trip
      return s == RobotStatus::Charging || s == RobotStatus::Docking ||
             s == RobotStatus::ReturningToDock;
    case RobotEventType::ChargeStalled: return s == RobotStatus::Charging;
    case RobotEventType::Error: return s != RobotStatus::Error;
    case RobotEventType::Recovery:
      return s == RobotStatus::Error || s == RobotStatus::Manual || s == RobotStatus::Stopped;
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
  std::vector<std::string> motion;  // "halt", "brake", "edge a>b", "creep", "jog f", "dock"
  EdgeDrive edge_drive = EdgeDrive::Forward;  // of the last edge

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
  void brake() override { motion.push_back("brake"); }
  void follow_edge(NodeIndex from, NodeIndex to, EdgeDrive d) override {
    motion.push_back(std::string("edge ") + GRAPH_NODES[from].id + ">" + GRAPH_NODES[to].id);
    edge_drive = d;
  }
  void creep() override { motion.push_back("creep"); }
  void jog(JogDirection d) override { motion.push_back(d == JogDirection::Backward ? "jog b" : "jog f"); }
  void drive(int16_t speed) override { motion.push_back("drive " + std::to_string(speed)); }
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
  void contact_lost() {
    core.on_charge_lost(now);
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

static Command jog(JogDirection d, CommandSource source = CommandSource::Local) {
  Command c = make(CommandType::Jog);
  c.direction = d;
  c.source = source;
  return c;
}

static void test_boot() {
  SCENARIO("boot");
  Rig r;
  r.core.begin();
  CHECK(r.status() == RobotStatus::Initializing);
  CHECK(r.last_motion() == "creep");
  // No work before the robot knows where it is.
  r.command(navigate("t1", "water-01", TargetAction::Water, 1000));
  r.command(make(CommandType::ReturnToDock, "d1"));
  CHECK(r.status() == RobotStatus::Initializing && r.events.empty());
  CHECK(r.last_motion() == "creep");
  r.tag(nullptr);  // a tag that isn't in the graph
  CHECK(r.status() == RobotStatus::Initializing);
  r.tag("cp-01");
  CHECK(r.status() == RobotStatus::Idle && r.node() == "cp-01" && r.events.empty());
  CHECK(r.last_motion() == "halt");
  TelemetryMsg t = {};
  r.core.snapshot(t);
  // It never turns, and is set down facing away from the dock.
  CHECK(t.heading_known && t.heading == Heading::East);
}

static void test_before_first_tag() {
  SCENARIO("stop and the controller before the first tag");
  // Stop halts the search; resume picks it back up.
  Rig r;
  r.core.begin();
  r.command(make(CommandType::Stop));
  CHECK(r.status() == RobotStatus::Stopped && r.latched() && r.last_motion() == "halt");
  r.command(navigate("t1", "water-01", TargetAction::Water, 1000));
  CHECK(r.status() == RobotStatus::Stopped);
  r.command(make(CommandType::Resume));
  CHECK(r.status() == RobotStatus::Initializing && !r.latched() && r.last_motion() == "creep");
  // A tag read while stopped places it: resume goes idle.
  r.command(make(CommandType::Stop));
  r.tag("cp-01");
  CHECK(r.status() == RobotStatus::Stopped && r.node() == "cp-01");
  r.command(make(CommandType::Resume));
  CHECK(r.status() == RobotStatus::Idle);

  // The controller takes over while creeping, or after the search gave up.
  Rig c;
  c.core.begin();
  c.command(jog(JogDirection::Forward, CommandSource::Controller));
  CHECK(c.status() == RobotStatus::Manual && c.last_motion() == "jog f" && c.node() == "");
  CHECK(c.events.empty());
  // Still no work from the dashboard while it has no node.
  c.command(navigate("t1", "water-01", TargetAction::Water, 1000));
  CHECK(c.status() == RobotStatus::Manual && c.last_motion() == "jog f");
  // Timeout with no tag: halted, still initializing; it doesn't drive off.
  c.advance(MANUAL_TIMEOUT_MS);
  CHECK(c.status() == RobotStatus::Initializing && c.last_motion() == "halt");
  c.core.fault("no tag found");
  c.command(jog(JogDirection::Backward, CommandSource::Controller));
  CHECK(c.status() == RobotStatus::Manual && c.last_motion() == "jog b");
  // Resume hands it back: the search starts again.
  c.command(make(CommandType::Resume));
  CHECK(c.status() == RobotStatus::Initializing && c.last_motion() == "creep");
  // Resume while halted after a timeout also restarts the search.
  c.command(jog(JogDirection::Forward, CommandSource::Controller));
  c.advance(MANUAL_TIMEOUT_MS);
  c.command(make(CommandType::Resume));
  CHECK(c.status() == RobotStatus::Initializing && c.last_motion() == "creep");
  // Driven onto a tag: leaving manual, it knows where it is.
  c.command(jog(JogDirection::Forward, CommandSource::Controller));
  c.tag("dock-1");
  CHECK(c.status() == RobotStatus::Manual && c.node() == "dock-1");
  c.advance(MANUAL_TIMEOUT_MS);
  CHECK(c.status() == RobotStatus::Idle && c.node() == "dock-1");
  // B (stop) during manual before a tag: stopped; resume searches again.
  Rig b;
  b.core.begin();
  b.command(jog(JogDirection::Forward, CommandSource::Controller));
  b.command(make(CommandType::Stop));
  CHECK(b.status() == RobotStatus::Stopped);
  b.command(make(CommandType::Resume));
  CHECK(b.status() == RobotStatus::Initializing && b.last_motion() == "creep");
  // Not at the motor cutoff.
  Rig k;
  k.core.begin();
  k.battery(BATTERY_CUTOFF_PCT);
  k.command(jog(JogDirection::Forward, CommandSource::Controller));
  CHECK(k.status() == RobotStatus::Initializing);

  // The dashboard's jogs work before the first tag too, like the controller's.
  Rig d;
  d.core.begin();
  d.command(jog(JogDirection::Backward));
  CHECK(d.status() == RobotStatus::Manual && d.last_motion() == "jog b" && d.events.empty());
  d.advance(MANUAL_TIMEOUT_MS);
  CHECK(d.status() == RobotStatus::Initializing && d.last_motion() == "halt");
  d.command(make(CommandType::Stop));
  d.command(jog(JogDirection::Forward));
  CHECK(d.status() == RobotStatus::Manual);
  d.command(make(CommandType::Resume));
  CHECK(d.status() == RobotStatus::Initializing && d.last_motion() == "creep");
  d.command(jog(JogDirection::Forward));
  d.tag("cp-01");
  d.command(make(CommandType::Resume));
  CHECK(d.status() == RobotStatus::Idle && d.node() == "cp-01");
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

  // A navigate without a task_id: last_completed_task_id stays.
  r.command(navigate("", "cp-01", TargetAction::Idle));
  CHECK(r.status() == RobotStatus::EnRoute && r.task().empty());
  r.tag("cp-01");
  CHECK(r.status() == RobotStatus::Idle && r.last_completed() == "t5");
  r.command(navigate("t5b", "cp-02", TargetAction::Idle));
  r.tag("water-01");
  r.tag("cp-02");

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
  r.command(navigate("t1", "cp-11", TargetAction::Water, 10));
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
  r.drive({"water-01", "cp-02", "elev-1-L0", "elev-1-L1", "cp-11"});
  CHECK(r.status() == RobotStatus::Working);
  TelemetryMsg t = {};
  r.core.snapshot(t);
  CHECK(t.heading_known && t.heading == Heading::East);

  // An elevator is never a target: the robot only passes through.
  r.advance(10);
  r.clear();
  r.command(navigate("t2", "elev-1-L1", TargetAction::Water, 10));
  CHECK(r.emitted({RobotEventType::TaskFailed}) && r.last_event().task_id == "t2");
  CHECK(r.status() == RobotStatus::Idle && r.task().empty());
}

static void test_drive_direction() {
  SCENARIO("forward, backward, elevator");
  Rig r;
  r.boot_at("water-01");
  // Toward the dock: backward, heading kept, rear sensor.
  r.command(navigate("t1", "dock-1", TargetAction::Water, 10));
  CHECK(r.last_motion() == "edge water-01>cp-01" && r.edge_drive == EdgeDrive::Backward);
  CHECK(r.core.reversing());
  r.tag("cp-01");
  CHECK(r.last_motion() == "edge cp-01>dock-1" && r.edge_drive == EdgeDrive::Backward);
  TelemetryMsg t = {};
  r.core.snapshot(t);
  CHECK(t.heading == Heading::East);
  r.tag("dock-1");

  // Away from it: forward, onto the elevator; off it the other way.
  r.command(navigate("t2", "cp-11", TargetAction::Water, 10));
  CHECK(r.edge_drive == EdgeDrive::Forward && !r.core.reversing());
  r.drive({"cp-01", "water-01", "cp-02"});
  CHECK(r.last_motion() == "edge cp-02>elev-1-L0" && r.edge_drive == EdgeDrive::Forward);
  r.tag("elev-1-L0");
  CHECK(r.last_motion() == "edge elev-1-L0>elev-1-L1");
  CHECK(r.edge_drive == EdgeDrive::ElevatorBackward && r.core.reversing());
  // Its tag read again during the ride: still drives off the same way.
  r.tag("elev-1-L0");
  CHECK(r.last_motion() == "edge elev-1-L0>elev-1-L1");
  CHECK(r.edge_drive == EdgeDrive::ElevatorBackward);
  // Stopped during the ride and resumed: the same.
  r.command(make(CommandType::Stop));
  r.command(make(CommandType::Resume));
  CHECK(r.last_motion() == "edge elev-1-L0>elev-1-L1");
  CHECK(r.edge_drive == EdgeDrive::ElevatorBackward);
  r.tag("elev-1-L1");
  CHECK(r.last_motion() == "edge elev-1-L1>cp-11" && r.edge_drive == EdgeDrive::Backward);
  r.tag("cp-11");
  CHECK(r.status() == RobotStatus::Working);
  r.core.snapshot(t);
  CHECK(t.heading == Heading::East);

  // Up two levels: one ride, off only at the top.
  Rig two;
  two.boot_at("cp-02");
  two.command(navigate("t5", "cp-21", TargetAction::Water, 10));
  two.tag("elev-1-L0");
  CHECK(two.last_motion() == "edge elev-1-L0>elev-1-L2");
  CHECK(two.edge_drive == EdgeDrive::ElevatorBackward);
  two.tag("elev-1-L2");
  CHECK(two.last_motion() == "edge elev-1-L2>cp-21" && two.edge_drive == EdgeDrive::Backward);
  // And back down from a level-2 checkpoint: forward onto it, off at the bottom.
  two.tag("cp-21");
  two.command(navigate("t6", "cp-02", TargetAction::Water, 10));
  CHECK(two.last_motion() == "edge cp-21>elev-1-L2" && two.edge_drive == EdgeDrive::Forward);
  two.tag("elev-1-L2");
  CHECK(two.last_motion() == "edge elev-1-L2>elev-1-L0");
  CHECK(two.edge_drive == EdgeDrive::ElevatorBackward);

  // Crept forward onto the elevator after boot: drives off backward.
  Rig e;
  e.boot_at("elev-1-L0");
  e.command(navigate("t3", "cp-11", TargetAction::Water, 10));
  CHECK(e.edge_drive == EdgeDrive::ElevatorBackward);
  // Backed onto it (a backward jog over its tag): drives off forward.
  Rig j;
  j.boot_at("cp-02");
  j.command(jog(JogDirection::Backward));
  j.tag("elev-1-L0");
  j.command(make(CommandType::Resume));
  j.command(navigate("t4", "cp-11", TargetAction::Water, 10));
  CHECK(j.edge_drive == EdgeDrive::ElevatorForward && !j.core.reversing());
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
  CHECK(r.last_motion() == "brake");  // on the contacts: no rolling on
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

static void test_charge_lost() {
  SCENARIO("knocked off the charger");
  // Charged enough: done charging, and carries on with the kept task.
  Rig r;
  r.boot_at("water-01");
  r.command(navigate("t1", "cp-02", TargetAction::Water, 1000));
  r.command(make(CommandType::ReturnToDock));
  r.drive({"cp-01", "dock-1"});
  r.contact();
  r.clear();
  r.battery(CHARGE_RESUME_PCT);
  r.contact_lost();
  CHECK(r.emitted({RobotEventType::ChargeComplete}));
  CHECK(r.status() == RobotStatus::EnRoute && r.task() == "t1");
  CHECK(r.last_motion() == "edge dock-1>cp-01");

  // Too low: backs onto the dock again, keeping the task, and charges on.
  Rig r2;
  r2.boot_at("water-01");
  r2.command(navigate("t1", "cp-02", TargetAction::Water, 1000));
  r2.command(make(CommandType::ReturnToDock));
  r2.drive({"cp-01", "dock-1"});
  r2.contact();
  r2.clear();
  r2.battery(CHARGE_RESUME_PCT - 0.1f);
  r2.contact_lost();
  CHECK(r2.events.empty() && r2.status() == RobotStatus::Docking);
  CHECK(r2.last_motion() == "dock" && r2.task() == "t1");
  r2.contact();
  CHECK(r2.emitted({RobotEventType::DockConnected}) && r2.status() == RobotStatus::Charging);
  // No reading yet counts as too low.
  r2.battery(NAN);
  r2.contact_lost();
  CHECK(r2.status() == RobotStatus::Docking);

  // A stop still holds; nothing is lost while not charging.
  Rig r3;
  r3.boot_at("dock-1");
  r3.command(make(CommandType::ReturnToDock, "d1"));
  r3.contact();
  r3.command(make(CommandType::Stop));
  r3.clear();
  r3.contact_lost();  // stopped: not charging
  CHECK(r3.status() == RobotStatus::Stopped && r3.events.empty());
  r3.command(make(CommandType::Resume));  // still on the charger
  CHECK(r3.status() == RobotStatus::Charging);
  Rig r4;
  r4.boot_at("cp-01");
  r4.command(navigate("t1", "cp-02", TargetAction::Water, 1000));
  r4.command(make(CommandType::Stop));
  r4.command(make(CommandType::ReturnToDock));  // latch kept
  r4.tag("dock-1");
  r4.contact();
  r4.clear();
  r4.battery(CHARGE_RESUME_PCT);
  r4.contact_lost();
  CHECK(r4.emitted({RobotEventType::ChargeComplete}) && r4.status() == RobotStatus::Stopped);
  CHECK(r4.task() == "t1");
}

static void test_charge_stalled() {
  SCENARIO("charge stalled");
  // Enough charge: off the charger as after charge_complete, with the task.
  Rig r;
  r.boot_at("water-01");
  r.command(navigate("t1", "cp-02", TargetAction::Water, 1000));
  r.command(make(CommandType::ReturnToDock));
  r.drive({"cp-01", "dock-1"});
  r.contact();
  r.battery(CHARGE_RESUME_PCT + 10);
  r.advance(10);  // starts the watch
  r.battery(CHARGE_RESUME_PCT + 10 + CHARGE_STALL_RISE_PCT - 0.1f);  // not enough of a rise
  r.clear();
  r.advance(CHARGE_STALL_MS - 1);
  CHECK(r.events.empty() && r.status() == RobotStatus::Charging);
  r.advance(1);
  CHECK(r.emitted({RobotEventType::ChargeStalled, RobotEventType::ChargeComplete}));
  CHECK(r.status() == RobotStatus::EnRoute && r.task() == "t1");

  // Too low to work: stays on the charger, says so once, keeps watching.
  Rig s;
  s.boot_at("cp-01");
  s.command(make(CommandType::ReturnToDock, "d1"));
  s.tag("dock-1");
  s.contact();
  s.battery(CHARGE_RESUME_PCT - 10);
  s.advance(10);
  s.clear();
  s.advance(CHARGE_STALL_MS);
  CHECK(s.emitted({RobotEventType::ChargeStalled}) && s.status() == RobotStatus::Charging);
  s.advance(CHARGE_STALL_MS);
  CHECK(s.events.size() == 1);
  // Rising again resets the watch; stalled above CHARGE_RESUME_PCT it leaves.
  s.battery(CHARGE_RESUME_PCT + 5);
  s.advance(10);
  s.advance(CHARGE_STALL_MS - 20);
  CHECK(s.status() == RobotStatus::Charging);
  s.advance(20);
  CHECK(s.emitted({RobotEventType::ChargeStalled, RobotEventType::ChargeComplete}));
  CHECK(s.status() == RobotStatus::Idle);

  // Rising steadily: never stalled.
  Rig g;
  g.boot_at("dock-1");
  g.command(make(CommandType::ReturnToDock));
  g.contact();
  g.clear();
  for (float pct = 30; pct < CHARGE_COMPLETE_PCT; pct += CHARGE_STALL_RISE_PCT) {
    g.battery(pct);
    g.advance(CHARGE_STALL_MS / 2);
  }
  CHECK(g.events.empty() && g.status() == RobotStatus::Charging);

  // A stop resets the watch: resumed on the charger, it starts again.
  g.command(make(CommandType::Stop));
  g.advance(CHARGE_STALL_MS * 2);
  g.command(make(CommandType::Resume));
  CHECK(g.status() == RobotStatus::Charging);
  g.advance(10);
  CHECK(g.events.empty() && g.status() == RobotStatus::Charging);
}

static void test_charge_complete_command() {
  SCENARIO("charge_complete command");
  // Charging, with a kept task: off the charger and on with it.
  Rig r;
  r.boot_at("water-01");
  r.command(navigate("t1", "cp-02", TargetAction::Water, 1000));
  r.command(make(CommandType::ReturnToDock));
  r.drive({"cp-01", "dock-1"});
  r.contact();
  r.battery(30);
  r.clear();
  r.command(make(CommandType::ChargeComplete));
  CHECK(r.emitted({RobotEventType::ChargeComplete}) && r.status() == RobotStatus::EnRoute);
  CHECK(r.task() == "t1");

  // On the way to the dock on a dock task: the task is done, then idle.
  Rig d;
  d.boot_at("water-01");
  d.command(make(CommandType::ReturnToDock, "d1"));
  CHECK(d.status() == RobotStatus::ReturningToDock);
  d.clear();
  d.command(make(CommandType::ChargeComplete));
  CHECK(d.emitted({RobotEventType::TaskComplete, RobotEventType::ChargeComplete}));
  CHECK(d.status() == RobotStatus::Idle && d.last_completed() == "d1" && d.task().empty());

  // Docking, stop latched: stopped, as after a full charge.
  Rig k;
  k.boot_at("cp-01");
  k.command(navigate("t1", "cp-02", TargetAction::Water, 1000));
  k.command(make(CommandType::Stop));
  k.command(make(CommandType::ReturnToDock));
  k.tag("dock-1");
  CHECK(k.status() == RobotStatus::Docking);
  k.command(make(CommandType::ChargeComplete));
  CHECK(k.status() == RobotStatus::Stopped && k.task() == "t1");

  // Not on a dock trip: ignored.
  Rig n;
  n.boot_at("cp-01");
  n.clear();
  n.command(make(CommandType::ChargeComplete));
  CHECK(n.events.empty() && n.status() == RobotStatus::Idle);
}

static bool drove_to_dock(const Rig& r) {
  for (const std::string& m : r.motion) {
    if (m == "dock" || m.rfind("edge", 0) == 0) return true;
  }
  return false;
}

static void test_bench_charge() {
  SCENARIO("charge_sense_always bench charge");
  // Off: a contact while idle does nothing.
  Rig off;
  off.boot_at("cp-01");
  off.contact();
  CHECK(off.events.empty() && off.status() == RobotStatus::Idle);

  // Idle: charges where it is, back to idle at CHARGE_COMPLETE_PCT.
  Rig r;
  r.core.set_charge_sense_always(true);
  r.boot_at("cp-01");
  r.battery(50);
  r.contact();
  CHECK(r.emitted({RobotEventType::DockConnected}) && r.status() == RobotStatus::Charging);
  r.clear();
  r.battery(CHARGE_COMPLETE_PCT);
  r.advance(100);
  CHECK(r.emitted({RobotEventType::ChargeComplete}) && r.status() == RobotStatus::Idle);
  CHECK(!drove_to_dock(r));

  // Unplugged under CHARGE_RESUME_PCT: the charge ends, it never backs on.
  Rig u;
  u.core.set_charge_sense_always(true);
  u.boot_at("cp-01");
  u.battery(20);
  u.contact();
  u.clear();
  u.contact_lost();
  CHECK(u.emitted({RobotEventType::ChargeComplete}) && u.status() == RobotStatus::Idle);
  CHECK(!drove_to_dock(u));

  // Stopped mid-task: back to stopped with the task and latch, then resume.
  Rig s;
  s.core.set_charge_sense_always(true);
  s.boot_at("cp-01");
  s.command(navigate("t1", "cp-02", TargetAction::Water, 1000));
  s.command(make(CommandType::Stop));
  s.battery(30);
  s.contact();
  CHECK(s.status() == RobotStatus::Charging && s.task() == "t1");
  s.clear();
  s.contact_lost();
  CHECK(s.emitted({RobotEventType::ChargeComplete}) && s.status() == RobotStatus::Stopped);
  CHECK(s.task() == "t1" && s.latched() && !drove_to_dock(s));
  s.command(make(CommandType::Resume));
  CHECK(s.status() == RobotStatus::EnRoute && s.task() == "t1");

  // Resumed while charging: carries on once the charge ends.
  Rig c;
  c.core.set_charge_sense_always(true);
  c.boot_at("cp-01");
  c.command(navigate("t1", "cp-02", TargetAction::Water, 1000));
  c.command(make(CommandType::Stop));
  c.battery(30);
  c.contact();
  c.command(make(CommandType::Resume));
  CHECK(c.status() == RobotStatus::Charging);
  c.command(make(CommandType::ChargeComplete));
  CHECK(c.status() == RobotStatus::EnRoute && c.task() == "t1");

  // Stopped while charging, then resumed: still charging there, not to the dock.
  Rig p;
  p.core.set_charge_sense_always(true);
  p.boot_at("cp-01");
  p.battery(30);
  p.contact();
  p.command(make(CommandType::Stop));
  p.clear();
  p.command(make(CommandType::Resume));
  CHECK(p.status() == RobotStatus::Charging && !drove_to_dock(p));
  // A real dock trip replaces it.
  p.command(make(CommandType::ReturnToDock));
  CHECK(p.status() == RobotStatus::ReturningToDock);
  p.tag("dock-1");
  p.contact();
  p.clear();
  p.command(make(CommandType::ChargeComplete));
  CHECK(p.emitted({RobotEventType::ChargeComplete}) && p.status() == RobotStatus::Idle);

  // On the real dock with the flag on: unplugged under 40% ends the charge
  // and carries on with the kept task, instead of backing on.
  Rig d;
  d.core.set_charge_sense_always(true);
  d.boot_at("water-01");
  d.command(navigate("t1", "cp-02", TargetAction::Water, 1000));
  d.command(make(CommandType::ReturnToDock));
  d.drive({"cp-01", "dock-1"});
  d.contact();
  d.battery(20);
  d.clear();
  d.contact_lost();
  CHECK(d.emitted({RobotEventType::ChargeComplete}) && d.status() == RobotStatus::EnRoute);
  CHECK(d.task() == "t1");
}

static void test_stop_latch_through_dock_trip() {
  SCENARIO("stop latch survives a dock trip");
  Rig r;
  r.boot_at("cp-01");
  r.command(navigate("t1", "cp-02", TargetAction::Water, 1000));
  r.command(make(CommandType::Stop));
  r.clear();
  // A stop beats the battery's forced return.
  r.core.survival_return("14.0%", r.now);
  CHECK(r.status() == RobotStatus::Stopped && r.events.empty());
  // An operator's return_to_dock still goes, keeping the stop latched.
  r.command(make(CommandType::ReturnToDock));
  CHECK(r.status() == RobotStatus::ReturningToDock && r.latched() && r.task() == "t1");
  r.core.survival_return("13.0%", r.now);  // already returning: nothing
  CHECK(r.events.empty());
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
  r2.command(make(CommandType::ReturnToDock));
  r2.command(make(CommandType::Resume));
  CHECK(r2.status() == RobotStatus::ReturningToDock && !r2.latched());
  r2.tag("dock-1");
  r2.contact();
  r2.battery(96);
  r2.advance(10);
  CHECK(r2.status() == RobotStatus::EnRoute && r2.task() == "t1");
}

static void test_survival_return() {
  SCENARIO("survival return");
  Rig r;
  r.boot_at("cp-01");
  r.command(navigate("t1", "cp-02", TargetAction::Water, 100000));
  r.drive({"water-01", "cp-02"});
  r.clear();
  // From working: battery_critical, then to the dock with the task kept.
  r.core.survival_return("15.0%", r.now);
  CHECK(r.emitted({RobotEventType::BatteryCritical}));
  CHECK(r.last_event().status_at_emit == RobotStatus::Working);
  CHECK(r.status() == RobotStatus::ReturningToDock && r.task() == "t1" && !r.latched());

  // Stopped anywhere, including mid-return: stays stopped.
  Rig r2;
  r2.boot_at("water-01");
  r2.command(make(CommandType::ReturnToDock));
  r2.command(make(CommandType::Stop));
  r2.clear();
  r2.core.survival_return("10.0%", r2.now);
  CHECK(r2.status() == RobotStatus::Stopped && r2.events.empty());
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

static Command drive(int16_t speed) {
  Command c = make(CommandType::Drive);
  c.speed = speed;
  c.source = CommandSource::Controller;
  return c;
}

static void test_drive() {
  SCENARIO("the controller's drive");
  // A jog at a speed: manual, the task kept, reversing below 0.
  Rig r;
  r.boot_at("cp-01");
  r.command(navigate("t1", "cp-02", TargetAction::Water, 1000));
  r.clear();
  r.command(drive(90));
  CHECK(r.status() == RobotStatus::Manual && r.task() == "t1" && r.last_motion() == "drive 90");
  CHECK(!r.core.reversing() && r.events.empty());
  r.command(drive(-140));
  CHECK(r.last_motion() == "drive -140" && r.core.reversing());
  // Each drive restarts the manual timeout.
  r.advance(MANUAL_TIMEOUT_MS - 1);
  r.command(drive(-140));
  r.advance(MANUAL_TIMEOUT_MS - 1);
  CHECK(r.status() == RobotStatus::Manual);
  r.advance(1);
  CHECK(r.status() == RobotStatus::EnRoute && r.task() == "t1");

  // Like the controller's jogs: it takes over a dock trip, and works before
  // the first tag, but not below the motor cutoff.
  Rig d;
  d.boot_at("cp-01");
  d.command(make(CommandType::ReturnToDock));
  d.command(drive(-60));
  CHECK(d.status() == RobotStatus::Manual && d.last_motion() == "drive -60");
  d.advance(MANUAL_TIMEOUT_MS);
  CHECK(d.status() == RobotStatus::ReturningToDock);
  Rig b;
  b.core.begin();
  b.command(drive(60));
  CHECK(b.status() == RobotStatus::Manual && b.node() == "");
  Rig k;
  k.boot_at("cp-01");
  k.battery(BATTERY_CUTOFF_PCT);
  k.command(drive(60));
  CHECK(k.status() == RobotStatus::Idle && k.last_motion() != "drive 60");
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

  // The Bluetooth controller overrides a dock trip; leaving manual resumes it.
  Rig r3;
  r3.boot_at("cp-01");
  r3.command(navigate("t3", "cp-02", TargetAction::Water, 1000));
  r3.command(make(CommandType::ReturnToDock));
  CHECK(r3.status() == RobotStatus::ReturningToDock && r3.task() == "t3");
  r3.command(jog(JogDirection::Forward, CommandSource::Controller));
  CHECK(r3.status() == RobotStatus::Manual && r3.task() == "t3" && r3.last_motion() == "jog f");
  r3.advance(MANUAL_TIMEOUT_MS);
  CHECK(r3.status() == RobotStatus::ReturningToDock && r3.task() == "t3");
  // Charging too, and resume heads back onto the charger.
  r3.drive({"dock-1"});
  r3.contact();
  CHECK(r3.status() == RobotStatus::Charging);
  r3.command(jog(JogDirection::Forward));
  CHECK(r3.status() == RobotStatus::Charging);
  r3.command(jog(JogDirection::Forward, CommandSource::Controller));
  CHECK(r3.status() == RobotStatus::Manual);
  r3.command(make(CommandType::Resume));
  CHECK(r3.status() == RobotStatus::Docking && r3.last_motion() == "dock");
  CHECK(r3.task() == "t3");
  // Still not at the motor cutoff.
  Rig r4;
  r4.boot_at("cp-01");
  r4.command(make(CommandType::ReturnToDock));
  r4.battery(BATTERY_CUTOFF_PCT);
  r4.command(jog(JogDirection::Forward, CommandSource::Controller));
  CHECK(r4.status() == RobotStatus::ReturningToDock);
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

  // A new task or a dock trip leaves error too: recovery first. Also from a
  // stop or manual control that interrupted the error.
  Rig r5;
  r5.boot_at("cp-01");
  r5.command(navigate("t1", "cp-02", TargetAction::Water, 1000));
  r5.core.fault("missed tag");
  r5.clear();
  r5.command(navigate("t2", "water-01", TargetAction::Water, 1000));
  CHECK(r5.emitted({RobotEventType::Recovery}) && r5.status() == RobotStatus::EnRoute);
  CHECK(r5.task() == "t2");
  r5.core.fault("missed tag");
  r5.clear();
  r5.command(make(CommandType::ReturnToDock));
  CHECK(r5.emitted({RobotEventType::Recovery}) && r5.status() == RobotStatus::ReturningToDock);
  r5.core.fault("missed tag");
  r5.command(make(CommandType::Stop));
  r5.clear();
  r5.command(navigate("t3", "water-01", TargetAction::Water, 1000));
  CHECK(r5.emitted({RobotEventType::Recovery}) && r5.status() == RobotStatus::EnRoute);
  r5.core.fault("missed tag");
  r5.command(jog(JogDirection::Forward));
  r5.clear();
  r5.command(navigate("t4", "water-01", TargetAction::Water, 1000));
  CHECK(r5.emitted({RobotEventType::Recovery}) && r5.status() == RobotStatus::EnRoute);
  // A navigate that fails leaves it in error: no recovery.
  r5.core.fault("missed tag");
  r5.clear();
  r5.command(navigate("t5", "elev-1-L0", TargetAction::Water, 1000));
  CHECK(r5.emitted({RobotEventType::TaskFailed}) && r5.status() == RobotStatus::Error);
  // Not in error: no recovery.
  r5.tag("water-01");
  r5.clear();
  r5.command(navigate("t6", "cp-02", TargetAction::Water, 1000));
  CHECK(r5.events.empty() || r5.events[0].type != RobotEventType::Recovery);

  // No tag found after boot: stops looking, still initializing.
  Rig r3;
  r3.core.begin();
  r3.core.fault("no tag found");
  CHECK(r3.emitted({RobotEventType::Error}) && r3.last_motion() == "halt");
  CHECK(r3.status() == RobotStatus::Initializing);
  r3.tag("cp-01");
  CHECK(r3.status() == RobotStatus::Idle);

  // Stopped: nothing is driving, so no fault applies.
  Rig r4;
  r4.boot_at("cp-01");
  r4.command(navigate("t1", "cp-02", TargetAction::Water, 1000));
  r4.command(make(CommandType::Stop));
  r4.clear();
  r4.core.fault("missed tag");
  CHECK(r4.status() == RobotStatus::Stopped && r4.events.empty());

  // An operator is driving: no fault applies.
  r3.command(navigate("t1", "cp-02", TargetAction::Water, 1000));
  r3.command(jog(JogDirection::Forward));
  r3.clear();
  r3.core.fault("missed tag");
  CHECK(r3.status() == RobotStatus::Manual && r3.events.empty());
}

int main() {
  test_boot();
  test_before_first_tag();
  test_task_cycle();
  test_navigate_edge_cases();
  test_command_path();
  test_path_following();
  test_drive_direction();
  test_stop_resume();
  test_dock_trip_keeps_task();
  test_dock_task();
  test_charge_lost();
  test_charge_stalled();
  test_charge_complete_command();
  test_bench_charge();
  test_stop_latch_through_dock_trip();
  test_survival_return();
  test_cancel();
  test_manual();
  test_drive();
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
  r3.command(navigate("t3", "c3", TargetAction::Water, 1000));
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
