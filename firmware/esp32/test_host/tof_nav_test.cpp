// tof_nav_test.cpp
// ToF navigation end to end on a laptop: NavCore, Motion and TofLocator
// wired the way the nav task wires them, driving a simulated robot along the
// farm graph (src/graph.cpp) with no tags at all.
//
// The simulated farm matches tof_locator_test: 50 cm per graph x unit, front
// = 230 - pos and rear = pos + 30 on every level. The elevator platform's end
// wall is the front board (reached at pos 228), the dock the rear board (pos
// -29). Speeds are DriveCommand speed * CM_S_PER_SPEED; a stop rolls on over
// STOP_RAMP_MS; the obstacle flag holds the motor like the motor task does.
// Build + run with ./run.sh

#include <math.h>
#include <stdio.h>
#include <string.h>

#include <string>
#include <vector>

#include "config.h"
#include "nav/motion.h"
#include "nav/nav_core.h"
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

static const float CM_PER_UNIT = 50;
static const float CM_S_PER_SPEED = 0.2f;  // CRUISE_SPEED 150: 30 cm/s
static const float LEVELS[] = {260, 260, 260};
static const float NO_LEVELS[] = {0, 0, 0};  // no length check
static const uint32_t TOF_PERIOD_MS = 33;

static float pos_of(const char* id) { return (float)GRAPH_NODES[N(id)].x * CM_PER_UNIT; }

static std::vector<TofNode> farm_table() {
  std::vector<TofNode> t;
  for (uint8_t i = 0; i < GRAPH_NODE_COUNT; i++) {
    float pos = (float)GRAPH_NODES[i].x * CM_PER_UNIT;
    float front = 230 - pos, rear = pos + 30;
    // A board beyond TOF_NAV_MAX_RANGE_CM isn't measured.
    t.push_back({GRAPH_NODES[i].id, front <= TOF_NAV_MAX_RANGE_CM ? front : 0,
                 rear <= TOF_NAV_MAX_RANGE_CM ? rear : 0});
  }
  return t;
}

class Sink : public DriveSink {
 public:
  void send(const DriveCommand& c) override {
    last = c;
    fresh = true;
  }
  DriveCommand last = {};
  bool fresh = false;
};

static Command make(CommandType type, const char* task_id = "") {
  Command c = {};
  c.type = type;
  strncpy(c.task_id, task_id, sizeof(c.task_id) - 1);
  c.priority = TaskPriority::Normal;
  c.source = CommandSource::Local;
  return c;
}

// The nav task's loop, against a simulated track.
class Farm : public NavOutput {
 public:
  std::vector<TofNode> table = farm_table();
  const float* levels;
  Sink sink;
  Motion motion{sink};
  NavCore core{*this};
  TofLocator tof{table.data(), table.size(), levels, 3};
  uint32_t now = 1000;
  float pos = 0;
  uint8_t level = 0;
  // Something in the track ahead of the robot (NAN: nothing), at this pos.
  float object_at = NAN;
  // A person in front of the robot, this far from its front sensor (NAN: none).
  float person_cm = NAN;
  float noise_cm = 0;  // added to every reading, alternating sign
  // Realistic readings: independent Gaussian noise on each side (this sigma,
  // cm), each measured this long before it reaches nav.
  float sigma_cm = 0;
  uint32_t lag_ms = 0;
  uint32_t seed = 1;
  // Each arrival's distance from its node's spot (cm), the worst so far.
  float worst_miss_cm = 0;
  std::vector<RobotEventType> events;
  std::vector<std::string> arrivals;  // node ids, as NavCore saw them

  explicit Farm(const float* level_cm = LEVELS) : levels(level_cm) {
    const char* err = tof.begin();
    if (err) printf("  test bug: %s\n", err);
  }

  // ---- NavOutput, as QueueOutput ----
  void event(RobotEventType type, const char*, NodeIndex, const char*) override {
    events.push_back(type);
  }
  void halt() override { motion.halt(); }
  void brake() override { motion.brake(); }
  void follow_edge(NodeIndex from, NodeIndex to, EdgeDrive drive) override {
    tof.on_edge(from, to, drive);
    if (drive == EdgeDrive::ElevatorForward || drive == EdgeDrive::ElevatorBackward) {
      ride_to_ = (uint8_t)lround(GRAPH_NODES[to].z);
    }
    motion.follow_edge(from, to, drive, now);
  }
  void creep() override {
    tof.on_creep();
    motion.creep(now);
  }
  void jog(JogDirection d) override {
    tof.on_untracked_move();
    motion.jog(d, now);
  }
  void drive(int16_t speed) override {
    tof.on_untracked_move();
    motion.drive(speed, now);
  }
  void start_docking() override {
    tof.on_untracked_move();
    motion.start_docking(now);
  }
  void note(const char*) override {}

  // ---- The track ----
  float board_front() const { return 230 - pos; }
  float front() const {
    float cm = board_front();
    if (!isnan(object_at) && object_at > pos) cm = fminf(cm, object_at - pos);
    if (!isnan(person_cm)) cm = fminf(cm, person_cm);
    return cm;
  }
  float rear() const { return pos + 30; }

  void command(const Command& c) { core.on_command(c, now); }

  // One nav loop: the robot moves NAV_LOOP_MS, maybe a new reading, then
  // what nav_task does after its queues.
  void loop() {
    move(NAV_LOOP_MS);
    now += NAV_LOOP_MS;
    past_.push_back({now, pos});
    if (now - read_ms_ >= TOF_PERIOD_MS) {
      read_ms_ = now;
      float n = (reads_++ % 2 ? noise_cm : -noise_cm);
      // Where it was lag_ms ago.
      float was = pos;
      for (auto it = past_.rbegin(); it != past_.rend(); ++it) {
        if (now - it->first >= lag_ms) {
          was = it->second;
          break;
        }
      }
      float lagged = was - pos;
      s_.obstacle_front_cm = front() - lagged + n + gauss() * sigma_cm;
      s_.obstacle_rear_cm = rear() + lagged + n + gauss() * sigma_cm;
      s_.tof_front_ms = now;
      s_.tof_rear_ms = now;
    }
    if (past_.size() > 64) past_.erase(past_.begin());
    s_.obstacle_front_stop = s_.obstacle_front_cm < motion.stop_cm(false);
    s_.obstacle_rear_stop = s_.obstacle_rear_cm < motion.stop_cm(true);
    // The dock's contacts: sprung pads, they touch within a few cm. (Motion
    // brakes on the first reading at DOCK_STOP_CM, so with noisy readings it
    // can stop a few cm short: DOCK_STOP_CM is tuned on the farm.)
    if (core.status() == RobotStatus::Docking && rear() <= DOCK_STOP_CM + 5) {
      core.on_charge_contact();
    }

    bool on_track = motion.driving_edge() || motion.creeping();
    TofSample ts = {s_.obstacle_front_cm, s_.tof_front_ms, s_.obstacle_front_stop,
                    s_.obstacle_rear_cm,  s_.tof_rear_ms,  s_.obstacle_rear_stop};
    NodeIndex reached = tof.update(on_track, core.status(), core.current_node(), ts, now);
    if (reached != NO_NODE) {
      arrivals.push_back(GRAPH_NODES[reached].id);
      float miss = fabsf(pos - (float)GRAPH_NODES[reached].x * CM_PER_UNIT);
      if (GRAPH_NODES[reached].z != level) miss = INFINITY;
      if (miss > worst_miss_cm) worst_miss_cm = miss;
      tof.on_tag(reached);
      core.on_tag(reached, now);
    }
    core.tick(now);
    const char* fault = motion.check(now, s_, false);
    if (fault) core.fault(fault);
  }

  // Loops until `done` or `ms` pass. True if done.
  template <typename F>
  bool run_until(F done, uint32_t ms) {
    for (uint32_t t = 0; t < ms; t += NAV_LOOP_MS) {
      if (done()) return true;
      loop();
    }
    return done();
  }

  bool saw(RobotEventType type) const {
    for (auto e : events) {
      if (e == type) return true;
    }
    return false;
  }

 private:
  void move(uint32_t ms) {
    if (sink.fresh) {
      sink.fresh = false;
      cmd_ms_ = now;
      if (sink.last.mode == DriveMode::Stop) {
        ramp_from_ = speed_;
        if (sink.last.brake) {
          speed_ = 0;
          // Braked on the platform: the elevator takes it to the level.
          if (ride_to_ != NO_LEVEL) {
            level = ride_to_;
            ride_to_ = NO_LEVEL;
          }
        }
      }
    }
    const DriveCommand& c = sink.last;
    float want = 0;
    if (c.mode == DriveMode::Drive && (c.duration_ms == 0 || now - cmd_ms_ < c.duration_ms)) {
      want = c.left_speed * CM_S_PER_SPEED;
    } else if (c.mode == DriveMode::Stop && !c.brake && now - cmd_ms_ < STOP_RAMP_MS) {
      want = ramp_from_ * (1.0f - (float)(now - cmd_ms_) / STOP_RAMP_MS);
    } else if (c.mode == DriveMode::Drive) {
      want = 0;  // a timed pulse ended (the motor task ramps it; close enough)
    }
    // The obstacle flag on the side it's driving toward holds the motor.
    if ((want > 0 && front() < motion.stop_cm(false)) || (want < 0 && rear() < motion.stop_cm(true))) {
      want = 0;
    }
    speed_ = want;
    pos += speed_ * ms / 1000.0f;
  }

  float gauss() {
    float sum = 0;
    for (int i = 0; i < 12; i++) {
      seed = seed * 1664525u + 1013904223u;
      sum += (seed >> 8) / 16777216.0f;
    }
    return sum - 6;
  }

  static const uint8_t NO_LEVEL = 0xFF;
  std::vector<std::pair<uint32_t, float>> past_;
  SensorData s_ = {};
  float speed_ = 0;
  float ramp_from_ = 0;
  uint32_t cmd_ms_ = 0;
  uint32_t read_ms_ = 0;
  uint32_t reads_ = 0;
  uint8_t ride_to_ = NO_LEVEL;
};

static Command navigate(const char* task_id, const char* target, TargetAction action,
                        uint32_t duration_ms) {
  Command c = make(CommandType::Navigate, task_id);
  strncpy(c.target_node, target, sizeof(c.target_node) - 1);
  c.action_at_target = action;
  c.has_duration = true;
  c.duration_ms = duration_ms;
  return c;
}

// Boots the robot at `pos` on L0 and creeps to the first node.
static void boot(Farm& f, float pos) {
  f.pos = pos;
  f.core.begin();
  CHECK(f.run_until([&] { return f.core.status() == RobotStatus::Idle; }, 20000));
}

static bool near(float a, float b, float tol) { return fabsf(a - b) <= tol; }

static void test_boot() {
  SCENARIO("boot: creeps to the first node");
  Farm f;
  boot(f, 20);
  CHECK(f.core.current_node() == N("cp-01"));
  CHECK(near(f.pos, pos_of("cp-01"), TOF_LOCALIZE_TOL_CM + 2));
  CHECK(!f.saw(RobotEventType::Error));
}

static void test_up_and_back() {
  SCENARIO("navigate up a level and back to the dock, no tags");
  Farm f;
  boot(f, 20);
  f.command(navigate("t1", "water-11", TargetAction::Water, 1000));
  CHECK(f.run_until([&] { return f.core.status() == RobotStatus::Working; }, 120000));
  CHECK(f.core.current_node() == N("water-11"));
  CHECK(f.level == 1);
  // Stopped at the station, give or take the roll-on.
  CHECK(near(f.pos, pos_of("water-11"), 6));
  std::vector<std::string> want = {"cp-01", "water-01", "cp-02", "elev-1-L0", "elev-1-L1",
                                   "cp-11", "water-11"};
  CHECK(f.arrivals == want);
  CHECK(f.run_until([&] { return f.core.status() == RobotStatus::Idle; }, 5000));
  CHECK(f.saw(RobotEventType::TaskComplete));

  f.command(make(CommandType::ReturnToDock));
  CHECK(f.run_until([&] { return f.core.status() == RobotStatus::Charging; }, 120000));
  CHECK(f.level == 0);
  CHECK(f.core.current_node() == N("dock-1"));
  CHECK(!f.saw(RobotEventType::Error));
}

static void test_stop_resume() {
  SCENARIO("stop mid-edge, resume");
  Farm f;
  boot(f, 20);
  f.command(navigate("t1", "water-01", TargetAction::Water, 0));
  CHECK(f.run_until([&] { return f.pos >= 75; }, 20000));
  f.command(make(CommandType::Stop));
  f.run_until([] { return false; }, 2000);
  CHECK(f.core.status() == RobotStatus::Stopped);
  float stopped_at = f.pos;
  f.command(make(CommandType::Resume));
  CHECK(f.run_until([&] { return f.core.status() == RobotStatus::Idle; }, 20000));
  CHECK(f.core.current_node() == N("water-01"));
  CHECK(f.pos > stopped_at);
  CHECK(!f.saw(RobotEventType::Error));
}

static void test_stop_past_node() {
  SCENARIO("stopped just after crossing a node, before the confirm");
  Farm f;
  boot(f, 20);
  f.command(navigate("t1", "cp-02", TargetAction::Water, 0));
  // Stop right as it reaches water-01 (pos 100), resume: it must not lose it.
  CHECK(f.run_until([&] { return f.pos >= 100.2f; }, 20000));
  f.command(make(CommandType::Stop));
  f.run_until([] { return false; }, 1000);
  f.command(make(CommandType::Resume));
  CHECK(f.run_until([&] { return f.core.status() == RobotStatus::Idle; }, 20000));
  CHECK(f.core.current_node() == N("cp-02"));
  CHECK(!f.saw(RobotEventType::Error));
}

static void test_noise() {
  SCENARIO("readings off by a couple of cm either way");
  Farm f;
  f.noise_cm = 2;
  boot(f, 20);
  f.command(navigate("t1", "water-11", TargetAction::Water, 0));
  CHECK(f.run_until([&] { return f.core.status() == RobotStatus::Idle; }, 120000));
  CHECK(f.core.current_node() == N("water-11"));
  CHECK(!f.saw(RobotEventType::Error));
}

static void test_object_in_track() {
  SCENARIO("something in the track: held, never a wrong node");
  Farm f;
  boot(f, 20);
  f.object_at = 130;  // in the beam for the whole edge, in front of water-01's spot
  f.command(navigate("t1", "cp-02", TargetAction::Water, 0));
  f.run_until([] { return false; }, 15000);
  // Held by the obstacle stop past water-01's spot, without taking it.
  CHECK(f.core.status() == RobotStatus::EnRoute);
  CHECK(f.arrivals.size() == 1);  // cp-01, at boot
  CHECK(f.core.current_node() == N("cp-01"));
  CHECK(f.pos > pos_of("water-01"));

  SCENARIO("... cleared: missed tag, then driven by hand onto water-01");
  f.object_at = NAN;
  CHECK(f.run_until([&] { return f.core.status() == RobotStatus::Error; }, 20000));
  CHECK(f.core.current_node() == N("cp-01"));
  // The controller's stick, gently, until it's on the spot.
  for (int i = 0; i < 200 && !near(f.pos, pos_of("water-01"), 1); i++) {
    Command c = make(CommandType::Drive);
    c.speed = f.pos > pos_of("water-01") ? -25 : 25;
    c.source = CommandSource::Controller;
    f.command(c);
    f.run_until([] { return false; }, PAD_PULSE_MS + STOP_RAMP_MS);
  }
  CHECK(f.core.status() == RobotStatus::Manual);
  CHECK(f.run_until([&] { return f.core.current_node() == N("water-01"); }, 3000));
  f.command(make(CommandType::Resume));  // leave manual: recovery, on to cp-02
  CHECK(f.run_until([&] { return f.core.status() == RobotStatus::Idle; }, 20000));
  CHECK(f.core.current_node() == N("cp-02"));
  CHECK(f.saw(RobotEventType::Recovery));
}

static void test_hand_mid_edge() {
  SCENARIO("a hand in front mid-edge, then taken away: arrives, no fault");
  Farm f;
  boot(f, 20);
  f.command(navigate("t1", "cp-02", TargetAction::Water, 0));
  CHECK(f.run_until([&] { return f.pos >= 65; }, 20000));
  f.object_at = f.pos + 35;  // slows it, then holds it at OBSTACLE_STOP_CM
  f.run_until([] { return false; }, 4000);
  CHECK(f.core.current_node() == N("cp-01"));
  f.object_at = NAN;
  CHECK(f.run_until([&] { return f.core.status() == RobotStatus::Idle; }, 20000));
  CHECK(f.core.current_node() == N("cp-02"));
  std::vector<std::string> want = {"cp-01", "water-01", "cp-02"};
  CHECK(f.arrivals == want);
  CHECK(!f.saw(RobotEventType::Error));
}

// Drives it with the controller's stick until it's within 1 cm of `target`.
static void drive_by_hand(Farm& f, float target) {
  for (int i = 0; i < 400 && !near(f.pos, target, 1); i++) {
    Command c = make(CommandType::Drive);
    c.speed = f.pos > target ? -25 : 25;
    c.source = CommandSource::Controller;
    f.command(c);
    f.run_until([] { return false; }, PAD_PULSE_MS + STOP_RAMP_MS);
  }
}

static void test_person_in_front_of_error() {
  SCENARIO("a robot in error, pushed onto a node with people walking by: stays in error");
  Farm f(NO_LEVELS);
  boot(f, 20);
  f.object_at = 130;  // in the beam all edge: passes water-01 unseen, then missed tag
  f.command(navigate("t1", "cp-02", TargetAction::Water, 0));
  f.run_until([] { return false; }, 15000);
  f.object_at = NAN;
  CHECK(f.run_until([&] { return f.core.status() == RobotStatus::Error; }, 30000));
  // Pushed by hand (no motor) onto cp-02: in error it waits for the
  // controller or a resume, even when its readings match a node.
  f.pos = pos_of("cp-02");
  // Stand in front for a while, leave, and come back.
  for (int i = 0; i < 3; i++) {
    f.person_cm = 60;
    f.run_until([] { return false; }, 2000);
    f.person_cm = NAN;
    f.run_until([] { return false; }, 2000);
  }
  CHECK(f.core.status() == RobotStatus::Error);
  CHECK(!f.saw(RobotEventType::Recovery));
}

static void test_hand_after_ride() {
  SCENARIO("driving off the elevator: on the new level");
  Farm f;
  boot(f, 20);
  f.command(navigate("t1", "water-11", TargetAction::Water, 0));
  CHECK(f.run_until([&] { return f.core.current_node() == N("elev-1-L1"); }, 120000));
  CHECK(f.level == 1);
  CHECK(f.tof.level_known());

  SCENARIO("... stopped and driven by hand onto cp-11: cp-11 (level 1), not cp-02");
  f.command(make(CommandType::Stop));
  f.run_until([] { return false; }, 1000);
  drive_by_hand(f, pos_of("cp-11"));
  CHECK(f.run_until([&] { return f.core.current_node() != N("elev-1-L1"); }, 3000));
  CHECK(f.core.current_node() == N("cp-11"));
}

static void test_ride_cut_short() {
  SCENARIO("a ride cut short by return_to_dock: level unknown, never docks on the wrong level");
  Farm f;
  boot(f, 20);
  f.command(navigate("t1", "water-11", TargetAction::Water, 0));
  // On the platform, riding.
  CHECK(f.run_until([&] { return f.level == 1; }, 120000));
  CHECK(!f.motion.driving_edge());
  f.command(make(CommandType::ReturnToDock));
  CHECK(!f.tof.level_known());
  f.run_until([] { return false; }, 30000);
  CHECK(f.core.status() != RobotStatus::Docking && f.core.status() != RobotStatus::Charging);
  CHECK(f.core.current_node() == N("elev-1-L0"));  // nothing taken since
  CHECK(f.saw(RobotEventType::Error));  // missed tag: an operator's turn
}

static void test_ride_resumed() {
  SCENARIO("stopped during a ride and resumed: same ride, level kept");
  Farm f;
  boot(f, 20);
  f.command(navigate("t1", "water-11", TargetAction::Water, 0));
  CHECK(f.run_until([&] { return f.level == 1; }, 120000));
  f.command(make(CommandType::Stop));
  f.run_until([] { return false; }, 1000);
  f.command(make(CommandType::Resume));
  CHECK(f.tof.level_known());
  CHECK(f.run_until([&] { return f.core.status() == RobotStatus::Idle; }, 60000));
  CHECK(f.core.current_node() == N("water-11"));
  CHECK(!f.saw(RobotEventType::Error));
}

static void test_realistic_missions() {
  SCENARIO("realistic readings: noise, lag, many missions up a level and back");
  int done = 0, runs = 0;
  float worst = 0;
  for (float sigma : {1.0f, 2.0f}) {
    for (uint32_t seed = 1; seed <= 15; seed++) {
      Farm f;
      f.sigma_cm = sigma;
      f.lag_ms = 35;
      f.seed = seed;
      boot(f, 20);
      f.command(navigate("t1", "water-11", TargetAction::Water, 0));
      bool up = f.run_until([&] { return f.core.status() == RobotStatus::Idle ||
                                         f.core.status() == RobotStatus::Error; }, 120000);
      bool ok = up && f.core.current_node() == N("water-11") && f.level == 1;
      if (ok) {
        f.command(make(CommandType::ReturnToDock));
        ok = f.run_until([&] { return f.core.status() == RobotStatus::Charging ||
                                      f.core.status() == RobotStatus::Error; }, 120000) &&
             f.core.status() == RobotStatus::Charging && f.level == 0;
      }
      runs++;
      if (ok) done++;
      if (f.worst_miss_cm > worst) worst = f.worst_miss_cm;
    }
  }
  printf("  realistic missions: %d/%d completed, worst arrival %.1f cm from its spot\n", done,
         runs, worst);
  // Never a wrong node: within the roll-on window of every spot, on its level.
  CHECK(worst <= TOF_NAV_MAX_STEP_CM + TOF_NAV_MAX_SPEED_CM_S * STOP_RAMP_MS / 2000.0f);
  CHECK(done == runs);
}

int main() {
  test_boot();
  test_up_and_back();
  test_stop_resume();
  test_stop_past_node();
  test_noise();
  test_object_in_track();
  test_hand_mid_edge();
  test_person_in_front_of_error();
  test_hand_after_ride();
  test_ride_cut_short();
  test_ride_resumed();
  test_realistic_missions();
  if (failures) {
    printf("tof_nav_test: %d failure(s)\n", failures);
    return 1;
  }
  printf("tof_nav_test: passed\n");
  return 0;
}
