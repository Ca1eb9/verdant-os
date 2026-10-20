// encoder_assist_test.cpp
// Drives the encoder assist (src/nav/encoder_assist) wired to NavCore and
// Motion the way the nav task does, against the farm graph (src/graph.cpp):
//
//   dock-1 - cp-01 - water-01 - cp-02 - elev-1-L0 = elev-1-L1 - cp-11 ...
//
// The robot faces east (forward = toward the elevator). Checks a missed tag
// taken as read at a target, before the elevator and dock approaches and
// mid-path, only once in a row, real tags restarting the count, and no
// guesses without counts, after a jog or on an edge it has no counts for.
// Build + run with ./run.sh

#include <math.h>
#include <stdio.h>
#include <string.h>

#include <string>
#include <vector>

#include "config.h"
#include "nav/encoder_assist.h"
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

// Measured edges for the tests; water-01 -> cp-02 is left out on purpose.
constexpr int32_t EDGE = 2000;
constexpr EncoderEdge EDGES[] = {
    {"dock-1", "cp-01", EDGE},  {"cp-01", "dock-1", EDGE},     {"cp-01", "water-01", EDGE},
    {"water-01", "cp-01", EDGE}, {"cp-02", "elev-1-L0", EDGE},
};
// Counts per nav loop while driving, and the loops to the guess.
constexpr int32_t STEP = 100;
constexpr int LOOPS_TO_GUESS = (int)(ENCODER_PASS_RATIO * EDGE / STEP + 0.999f);

static SensorData open_road() {
  SensorData s = {};
  s.obstacle_front_cm = NAN;
  s.obstacle_rear_cm = NAN;
  return s;
}

class Sink : public DriveSink {
 public:
  std::vector<DriveCommand> sent;
  void send(const DriveCommand& c) override { sent.push_back(c); }
  bool last_is_drive(int16_t speed) const {
    const DriveCommand& c = sent.back();
    return c.mode == DriveMode::Drive && c.left_speed == speed && c.duration_ms == 0;
  }
};

// NavCore -> Motion and EncoderAssist, as in nav_task.cpp.
class Robot : public NavOutput {
 public:
  Sink sink;
  Motion motion{sink};
  EncoderAssist assist{EDGES, sizeof(EDGES) / sizeof(EDGES[0])};
  NavCore core{*this};
  uint32_t now = 1000;
  std::vector<RobotEventType> events;
  std::string last_details;
  int guesses = 0;

  void event(RobotEventType type, const char*, NodeIndex, const char* details) override {
    events.push_back(type);
    last_details = details;
  }
  void halt() override { motion.halt(); }
  void brake() override { motion.brake(); }
  void follow_edge(NodeIndex from, NodeIndex to, EdgeDrive drive) override {
    assist.on_edge(from, to, drive);
    motion.follow_edge(from, to, drive, now);
  }
  void creep() override {
    assist.on_untracked_move();
    motion.creep(now);
  }
  void jog(JogDirection d) override {
    assist.on_untracked_move();
    motion.jog(d, now);
  }
  void drive(int16_t speed) override {
    assist.on_untracked_move();
    motion.drive(speed, now);
  }
  void start_docking() override {
    assist.on_untracked_move();
    motion.start_docking(now);
  }
  void note(const char*) override {}

  // One nav loop, `counts` driven since the last.
  void loop(int32_t counts, const SensorData& s = open_road()) {
    now += NAV_LOOP_MS;
    assist.on_counts(counts);
    NodeIndex guessed = assist.check(core.status());
    if (guessed != NO_NODE) {
      guesses++;
      core.on_tag(guessed, now);
    }
    core.tick(now);
    const char* fault = motion.check(now, s, false);
    if (fault) core.fault(fault);
  }
  void drive_loops(int n, int32_t counts) {
    for (int i = 0; i < n; i++) loop(counts);
  }
  void tag(const char* node) {
    assist.on_tag();
    core.on_tag(N(node), now);
  }
  void command(CommandType type, const char* target = "") {
    Command c = {};
    c.type = type;
    strncpy(c.target_node, target, sizeof(c.target_node) - 1);
    c.action_at_target = TargetAction::Water;
    core.on_command(c, now);
  }
  // Boots onto `node`, battery fine.
  void place(const char* node) {
    core.on_battery(80.0f);
    core.begin();
    tag(node);
  }
};

static void test_destination() {
  SCENARIO("guess at the destination");
  Robot r;
  r.place("cp-01");
  r.command(CommandType::Navigate, "water-01");
  r.drive_loops(LOOPS_TO_GUESS - 1, STEP);
  CHECK(r.core.status() == RobotStatus::EnRoute && r.guesses == 0);
  // Past ENCODER_PASS_RATIO with no tag: arrives as on the tag.
  r.loop(STEP);
  CHECK(r.guesses == 1);
  CHECK(r.core.status() == RobotStatus::Working && r.core.current_node() == N("water-01"));
  CHECK(r.sink.sent.back().mode == DriveMode::Stop);
}

static void test_approaches() {
  SCENARIO("guess before the elevator approach");
  Robot r;
  r.place("cp-02");
  r.command(CommandType::Navigate, "cp-11");
  r.drive_loops(LOOPS_TO_GUESS, STEP);
  // Creeps in to the end wall, which the ToF stops it at, then rides.
  CHECK(r.guesses == 1 && r.core.current_node() == N("elev-1-L0"));
  CHECK(r.sink.last_is_drive(APPROACH_SPEED) && r.motion.stop_cm(false) == ELEVATOR_STOP_CM);
  SensorData wall = open_road();
  wall.obstacle_front_cm = ELEVATOR_STOP_CM;
  r.loop(STEP, wall);
  CHECK(r.sink.sent.back().mode == DriveMode::Stop && r.sink.sent.back().brake);

  SCENARIO("guess before the dock approach");
  Robot d;
  d.place("cp-01");
  d.command(CommandType::ReturnToDock);
  CHECK(d.core.status() == RobotStatus::ReturningToDock && d.sink.last_is_drive(-CRUISE_SPEED));
  // Backward: counts go negative.
  d.drive_loops(LOOPS_TO_GUESS, -STEP);
  CHECK(d.guesses == 1 && d.core.status() == RobotStatus::Docking);
  CHECK(d.sink.last_is_drive(-APPROACH_SPEED) && d.motion.stop_cm(true) == DOCK_STOP_CM);
  // The charge contact check still applies at the dock.
  SensorData dock = open_road();
  dock.obstacle_rear_cm = DOCK_STOP_CM;
  d.loop(0, dock);
  for (uint32_t t = 0; t < CHARGE_CONTACT_TIMEOUT_MS; t += NAV_LOOP_MS) d.loop(0, dock);
  CHECK(d.core.status() == RobotStatus::Error);
}

static void test_once_in_a_row() {
  SCENARIO("second guess in a row faults");
  Robot r;
  r.place("dock-1");
  r.command(CommandType::Navigate, "water-01");
  // cp-01 missed: taken as read, and on to water-01.
  r.drive_loops(LOOPS_TO_GUESS, STEP);
  CHECK(r.guesses == 1 && r.core.current_node() == N("cp-01"));
  CHECK(r.core.status() == RobotStatus::EnRoute && r.sink.last_is_drive(CRUISE_SPEED));
  // water-01 missed too: no second guess, the missed-tag timeout faults.
  for (uint32_t t = NAV_LOOP_MS; t < MISSED_TAG_TIMEOUT_MS; t += NAV_LOOP_MS) r.loop(STEP);
  CHECK(r.guesses == 1 && r.core.status() == RobotStatus::EnRoute);
  r.loop(STEP);
  CHECK(r.core.status() == RobotStatus::Error && r.last_details == "missed tag");

  // A real tag allows a guess again.
  r.tag("water-01");
  CHECK(r.core.status() == RobotStatus::Working);
  r.command(CommandType::Navigate, "dock-1");
  CHECK(r.core.status() == RobotStatus::EnRoute && r.sink.last_is_drive(-CRUISE_SPEED));
  r.drive_loops(LOOPS_TO_GUESS, -STEP);
  CHECK(r.guesses == 2 && r.core.current_node() == N("cp-01"));
}

static void test_real_tags() {
  SCENARIO("real tag resets the count");
  Robot r;
  r.place("dock-1");
  r.command(CommandType::Navigate, "water-01");
  // cp-01 read late, well past the edge's counts: it wins, and water-01 is
  // counted from it.
  r.drive_loops(LOOPS_TO_GUESS - 1, STEP);
  r.tag("cp-01");
  CHECK(r.guesses == 0 && r.core.status() == RobotStatus::EnRoute);
  r.drive_loops(LOOPS_TO_GUESS - 1, STEP);
  CHECK(r.guesses == 0 && r.core.status() == RobotStatus::EnRoute);
  r.loop(STEP);
  CHECK(r.guesses == 1 && r.core.status() == RobotStatus::Working);

  SCENARIO("stop keeps the count");
  Robot s;
  s.place("cp-01");
  s.command(CommandType::Navigate, "water-01");
  s.drive_loops(LOOPS_TO_GUESS / 2, STEP);
  s.command(CommandType::Stop);
  s.drive_loops(10, 0);
  s.command(CommandType::Resume);
  s.drive_loops(LOOPS_TO_GUESS - LOOPS_TO_GUESS / 2, STEP);
  CHECK(s.guesses == 1 && s.core.status() == RobotStatus::Working);
}

static void test_no_guess() {
  SCENARIO("no counts: tags only");
  // Encoder off or not wired: today's missed-tag fault, at the same time.
  Robot r;
  r.place("cp-01");
  r.command(CommandType::Navigate, "water-01");
  for (uint32_t t = NAV_LOOP_MS; t < MISSED_TAG_TIMEOUT_MS; t += NAV_LOOP_MS) r.loop(0);
  CHECK(r.core.status() == RobotStatus::EnRoute);
  r.loop(0);
  CHECK(r.guesses == 0 && r.core.status() == RobotStatus::Error);
  CHECK(r.last_details == "missed tag");

  SCENARIO("counts the wrong way");
  Robot w;
  w.place("cp-01");
  w.command(CommandType::Navigate, "water-01");
  w.drive_loops(LOOPS_TO_GUESS * 2, -STEP);
  CHECK(w.guesses == 0 && w.core.status() == RobotStatus::EnRoute);

  SCENARIO("edge not measured");
  Robot u;
  u.place("water-01");
  u.command(CommandType::Navigate, "cp-02");
  u.drive_loops(LOOPS_TO_GUESS * 2, STEP);
  CHECK(u.guesses == 0 && u.core.status() == RobotStatus::EnRoute);

  SCENARIO("jog disables until a tag");
  Robot j;
  j.place("cp-01");
  j.command(CommandType::Navigate, "water-01");
  j.drive_loops(5, STEP);
  Command jog = {};
  jog.type = CommandType::Jog;
  jog.direction = JogDirection::Backward;
  j.core.on_command(jog, j.now);
  CHECK(j.core.status() == RobotStatus::Manual);
  j.drive_loops(5, -STEP);
  j.command(CommandType::Resume);
  CHECK(j.core.status() == RobotStatus::EnRoute);
  j.drive_loops(LOOPS_TO_GUESS * 2, STEP);
  CHECK(j.guesses == 0);
  // The next real tag: guessing again.
  j.tag("cp-01");
  j.drive_loops(LOOPS_TO_GUESS, STEP);
  CHECK(j.guesses == 1 && j.core.status() == RobotStatus::Working);
}

int main() {
  test_destination();
  test_approaches();
  test_once_in_a_row();
  test_real_tags();
  test_no_guess();
  printf("encoder_assist_test: %s\n", failures ? "FAILED" : "passed");
  return failures ? 1 : 0;
}
