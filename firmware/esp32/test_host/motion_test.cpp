// motion_test.cpp
// Drives the motion hooks (src/nav/motion) on a laptop. The last scenario
// wires Motion to NavCore the way the nav task does, against the farm graph
// (src/graph.cpp):
//
//   dock-1 - cp-01 - water-01 - cp-02 - elev-1-L0 = elev-1-L1 - cp-11 ...
//
// Checks the DriveCommands each hook sends, the elevator wait, and every
// fault check() reports. Build + run with ./run.sh

#include <stdio.h>
#include <string.h>

#include <vector>

#include "config.h"
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

static bool same(const char* a, const char* b) {
  return a && b ? strcmp(a, b) == 0 : a == b;
}

class Sink : public DriveSink {
 public:
  std::vector<DriveCommand> sent;
  void send(const DriveCommand& c) override { sent.push_back(c); }
  const DriveCommand& last() const { return sent.back(); }
  bool last_is_drive(int16_t speed) const {
    return last().mode == DriveMode::Drive && last().left_speed == speed &&
           last().right_speed == speed && last().duration_ms == 0;
  }
};

static void test_follow_edge() {
  SCENARIO("follow edge");
  Sink s;
  Motion m(s);
  uint32_t now = 1000;

  m.follow_edge(N("cp-01"), N("water-01"), EdgeDrive::Forward, now);
  CHECK(s.sent.size() == 1 && s.last_is_drive(CRUISE_SPEED));
  CHECK(m.check(now += 20, false) == nullptr);
  m.follow_edge(N("water-01"), N("cp-01"), EdgeDrive::Backward, now);
  CHECK(s.last_is_drive(-CRUISE_SPEED));

  // A turn (placeholder): stops and reports it once.
  m.follow_edge(N("cp-01"), N("water-01"), EdgeDrive::Turn, now);
  CHECK(s.last().mode == DriveMode::Stop);
  CHECK(same(m.check(now += 20, false), "turn needed: not supported yet"));
  CHECK(m.check(now += 20, false) == nullptr);
  for (const DriveCommand& c : s.sent) CHECK(c.mode != DriveMode::Turn);
}

static void test_elevator() {
  SCENARIO("elevator");
  Sink s;
  Motion m(s);
  uint32_t now = 1000;

  // Stays put for the ride, then drives off; no missed tag while waiting.
  m.follow_edge(N("elev-1-L0"), N("elev-1-L1"), EdgeDrive::ElevatorBackward, now);
  CHECK(s.last().mode == DriveMode::Stop);
  size_t sent = s.sent.size();
  CHECK(m.check(now += ELEVATOR_WAIT_MS - 1, false) == nullptr);
  CHECK(s.sent.size() == sent);
  CHECK(m.check(now += 1, false) == nullptr);
  CHECK(s.last_is_drive(-CRUISE_SPEED));
  // The missed-tag clock starts when it drives off.
  CHECK(m.check(now += MISSED_TAG_TIMEOUT_MS - 1, false) == nullptr);
  CHECK(same(m.check(now += 1, false), "missed tag"));

  m.follow_edge(N("elev-1-L1"), N("elev-1-L0"), EdgeDrive::ElevatorForward, now);
  m.check(now += ELEVATOR_WAIT_MS, false);
  CHECK(s.last_is_drive(CRUISE_SPEED));

  // Two levels in one ride: twice the wait.
  m.follow_edge(N("elev-1-L0"), N("elev-1-L2"), EdgeDrive::ElevatorBackward, now);
  sent = s.sent.size();
  CHECK(m.check(now += 2 * ELEVATOR_WAIT_MS - 1, false) == nullptr);
  CHECK(s.sent.size() == sent);
  m.check(now += 1, false);
  CHECK(s.last_is_drive(-CRUISE_SPEED));

  // A stop during the ride cancels it.
  m.follow_edge(N("elev-1-L1"), N("elev-1-L0"), EdgeDrive::ElevatorForward, now);
  m.halt();
  sent = s.sent.size();
  CHECK(m.check(now += ELEVATOR_WAIT_MS * 2, false) == nullptr);
  CHECK(s.sent.size() == sent);
}

static void test_other_hooks() {
  SCENARIO("halt, jog, creep");
  Sink s;
  Motion m(s);
  m.creep(1000);
  CHECK(s.last_is_drive(CREEP_SPEED));
  m.halt();
  CHECK(s.last().mode == DriveMode::Stop);
  // Halted: nothing left to time out.
  CHECK(m.check(1000 + CREEP_TIMEOUT_MS * 2, false) == nullptr);

  m.jog(JogDirection::Backward);
  CHECK(s.last().mode == DriveMode::Drive && s.last().left_speed == -JOG_SPEED &&
        s.last().duration_ms == JOG_PULSE_MS);
  CHECK(m.check(100000, false) == nullptr);

  // Every command gets the next seq, whichever hook sent it.
  for (size_t i = 0; i < s.sent.size(); i++) CHECK(s.sent[i].seq == i + 1);
}

static void test_timeouts() {
  SCENARIO("timeouts");
  Sink s;
  Motion m(s);
  uint32_t now = 1000;

  // Missed tag: reported once, after MISSED_TAG_TIMEOUT_MS of driving.
  m.follow_edge(N("cp-01"), N("water-01"), EdgeDrive::Forward, now);
  CHECK(m.check(now += MISSED_TAG_TIMEOUT_MS - 1, false) == nullptr);
  CHECK(same(m.check(now += 1, false), "missed tag"));
  CHECK(m.check(now += MISSED_TAG_TIMEOUT_MS, false) == nullptr);

  // Time with the motors held off (obstacle, cutoff) doesn't count.
  m.follow_edge(N("water-01"), N("cp-01"), EdgeDrive::Backward, now);
  CHECK(m.check(now += MISSED_TAG_TIMEOUT_MS - 100, false) == nullptr);
  CHECK(m.check(now += MISSED_TAG_TIMEOUT_MS * 3, true) == nullptr);
  CHECK(m.check(now += 50, false) == nullptr);
  CHECK(same(m.check(now += 50, false), "missed tag"));

  // The next edge (a tag was read) starts the clock again.
  m.follow_edge(N("cp-01"), N("water-01"), EdgeDrive::Forward, now);
  CHECK(m.check(now += MISSED_TAG_TIMEOUT_MS - 1, false) == nullptr);
  m.follow_edge(N("cp-01"), N("water-01"), EdgeDrive::Forward, now);
  CHECK(m.check(now += MISSED_TAG_TIMEOUT_MS - 1, false) == nullptr);

  // Creeping has its own, longer limit.
  m.creep(now);
  CHECK(m.check(now += CREEP_TIMEOUT_MS - 1, false) == nullptr);
  CHECK(same(m.check(now += 1, false), "no tag found"));
}

// NavCore -> Motion, as in nav_task.cpp.
class Robot : public NavOutput {
 public:
  Sink sink;
  Motion motion{sink};
  NavCore core{*this};
  uint32_t now = 1000;
  std::vector<RobotEventType> events;

  void event(RobotEventType type, const char*, NodeIndex, const char*) override {
    events.push_back(type);
  }
  void halt() override { motion.halt(); }
  void follow_edge(NodeIndex from, NodeIndex to, EdgeDrive drive) override {
    motion.follow_edge(from, to, drive, now);
  }
  void creep() override { motion.creep(now); }
  void jog(JogDirection d) override { motion.jog(d); }
  void start_docking() override { motion.halt(); }
  void note(const char*) override {}

  void loop(uint32_t ms) {
    now += ms;
    core.tick(now);
    const char* fault = motion.check(now, false);
    if (fault) core.fault(fault);
  }
  void tag(const char* node) { core.on_tag(N(node), now); }
  void navigate(const char* task_id, const char* target) {
    Command c = {};
    c.type = CommandType::Navigate;
    strncpy(c.task_id, task_id, sizeof(c.task_id) - 1);
    strncpy(c.target_node, target, sizeof(c.target_node) - 1);
    c.action_at_target = TargetAction::Water;
    core.on_command(c, now);
  }
};

static void test_with_nav_core() {
  SCENARIO("with NavCore");
  // Boot: creeps, and gives up (still initializing) if no tag turns up.
  Robot r;
  r.core.on_battery(80.0f);
  r.core.begin();
  CHECK(r.sink.last_is_drive(CREEP_SPEED));
  r.loop(CREEP_TIMEOUT_MS);
  CHECK(r.events.size() == 1 && r.events[0] == RobotEventType::Error);
  CHECK(r.core.status() == RobotStatus::Initializing);
  CHECK(r.sink.last().mode == DriveMode::Stop);
  r.tag("cp-01");
  CHECK(r.core.status() == RobotStatus::Idle);

  // Up a level: forward to the elevator, until a missed tag puts it in error.
  r.navigate("t1", "cp-11");
  CHECK(r.core.status() == RobotStatus::EnRoute && r.sink.last_is_drive(CRUISE_SPEED));
  r.loop(MISSED_TAG_TIMEOUT_MS - 20);
  r.tag("water-01");
  r.loop(MISSED_TAG_TIMEOUT_MS - 20);
  CHECK(r.core.status() == RobotStatus::EnRoute);
  r.loop(20);
  CHECK(r.core.status() == RobotStatus::Error && r.sink.last().mode == DriveMode::Stop);
  CHECK(r.events.back() == RobotEventType::Error);

  // Set back on a tag: recovery, and it carries on.
  r.tag("water-01");
  CHECK(r.events.back() == RobotEventType::Recovery);
  CHECK(r.core.status() == RobotStatus::EnRoute && r.sink.last_is_drive(CRUISE_SPEED));
  r.tag("cp-02");
  r.tag("elev-1-L0");
  // On the elevator: waits, then backs off to the level-1 tag and on to cp-11.
  CHECK(r.sink.last().mode == DriveMode::Stop);
  r.loop(ELEVATOR_WAIT_MS);
  CHECK(r.sink.last_is_drive(-CRUISE_SPEED) && r.core.status() == RobotStatus::EnRoute);
  r.tag("elev-1-L1");
  CHECK(r.sink.last_is_drive(-CRUISE_SPEED));
  r.tag("cp-11");
  CHECK(r.core.status() == RobotStatus::Working);

  // Back toward the dock: backward, no turn.
  Robot d;
  d.core.on_battery(80.0f);
  d.core.begin();
  d.tag("water-01");
  d.navigate("t2", "dock-1");
  CHECK(d.core.status() == RobotStatus::EnRoute && d.sink.last_is_drive(-CRUISE_SPEED));
  d.tag("cp-01");
  CHECK(d.sink.last_is_drive(-CRUISE_SPEED));
}

int main() {
  test_follow_edge();
  test_elevator();
  test_other_hooks();
  test_timeouts();
  test_with_nav_core();
  printf("motion_test: %s\n", failures ? "FAILED" : "passed");
  return failures ? 1 : 0;
}
