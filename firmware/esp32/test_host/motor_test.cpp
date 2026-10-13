// motor_test.cpp
// Drives the motor task's rules (src/motor/motor_core) on a laptop: what the
// motor does for each DriveCommand, the timed Drive, the reversal ramp and
// the safety flags (types.h, "nav task -> motor task").
// Build + run with ./run.sh

#include <stdio.h>

#include "config.h"
#include "motor/motor_core.h"

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

static uint32_t g_seq = 0;

static DriveCommand drive(int16_t speed, uint32_t duration_ms = 0) {
  DriveCommand c = {};
  c.seq = ++g_seq;
  c.mode = DriveMode::Drive;
  c.left_speed = speed;
  c.right_speed = speed;
  c.duration_ms = duration_ms;
  return c;
}
static DriveCommand stop() {
  DriveCommand c = {};
  c.seq = ++g_seq;
  c.mode = DriveMode::Stop;
  return c;
}

// One motor cycle with no flags set.
static int16_t run(MotorCore& m, uint32_t now) { return m.update(now, false, false, false); }
// Stopped, and the motor task has applied it: the next Drive starts from rest.
// (A Drive that replaces a Stop still in the mailbox ramps from the old speed.)
static void halt(MotorCore& m, uint32_t now) {
  m.command(stop(), now);
  run(m, now);
}

static void test_commands() {
  SCENARIO("commands");
  MotorCore m;
  uint32_t now = 1000;
  CHECK(run(m, now) == 0);  // nothing commanded since boot

  m.command(drive(CRUISE_SPEED), now);
  CHECK(run(m, now) == CRUISE_SPEED);
  CHECK(run(m, now += 60000) == CRUISE_SPEED);  // until replaced
  // The newest command replaces the last; the same way needs no ramp.
  m.command(drive(APPROACH_SPEED), now);
  CHECK(run(m, now) == APPROACH_SPEED);
  m.command(stop(), now);
  CHECK(run(m, now) == 0);
  m.command(drive(-CRUISE_SPEED), now);  // from a stop: no ramp either
  CHECK(run(m, now) == -CRUISE_SPEED);
  CHECK(m.done_seq() == 0 && !m.held());

  // Out-of-range speeds are clamped; a zero-speed Drive is a stop.
  halt(m, now);
  m.command(drive(1000), now);
  CHECK(run(m, now) == 255);
  halt(m, now);
  m.command(drive(-1000), now);
  CHECK(run(m, now) == -255);
  m.command(drive(0), now);
  CHECK(run(m, now) == 0);

  // A Drive that replaces a Stop the motor task never ran still ramps: the
  // motor is turning the old way.
  m.command(drive(CRUISE_SPEED), now);
  run(m, now);
  m.command(stop(), now);
  m.command(drive(-CRUISE_SPEED), now);
  CHECK(run(m, now) == CRUISE_SPEED && run(m, now + REVERSE_RAMP_MS) == -CRUISE_SPEED);

  // A Turn can't be done with one motor: the motor stops.
  m.command(drive(CRUISE_SPEED), now);
  run(m, now);
  DriveCommand turn = {};
  turn.seq = ++g_seq;
  turn.mode = DriveMode::Turn;
  turn.turn = Turn::Right;
  turn.left_speed = 200;  // ignored
  m.command(turn, now);
  CHECK(run(m, now) == 0 && run(m, now + 5000) == 0);
}

static void test_timed_drive() {
  SCENARIO("timed drive");
  MotorCore m;
  uint32_t now = 1000;

  DriveCommand jog = drive(JOG_SPEED, JOG_PULSE_MS);
  m.command(jog, now);
  CHECK(run(m, now) == JOG_SPEED);
  CHECK(run(m, now + JOG_PULSE_MS - 1) == JOG_SPEED && m.done_seq() == 0);
  CHECK(run(m, now + JOG_PULSE_MS) == 0 && m.done_seq() == jog.seq);
  CHECK(run(m, now + JOG_PULSE_MS * 10) == 0);

  // A jog while driving restarts the window (held button on the dashboard).
  now = 10000;
  m.command(drive(JOG_SPEED, JOG_PULSE_MS), now);
  run(m, now);
  DriveCommand second = drive(JOG_SPEED, JOG_PULSE_MS);
  m.command(second, now += 400);
  CHECK(run(m, now + JOG_PULSE_MS - 1) == JOG_SPEED);
  CHECK(run(m, now + JOG_PULSE_MS) == 0 && m.done_seq() == second.seq);

  // Replaced before it runs out: it never reports done.
  now = 20000;
  DriveCommand replaced = drive(JOG_SPEED, JOG_PULSE_MS);
  m.command(replaced, now);
  run(m, now);
  m.command(stop(), now += 100);
  CHECK(run(m, now + JOG_PULSE_MS) == 0 && m.done_seq() == second.seq);

  // millis() wrapping mid-pulse doesn't end or stretch it.
  now = UINT32_MAX - 100;
  m.command(drive(JOG_SPEED, JOG_PULSE_MS), now);
  CHECK(run(m, now + 200) == JOG_SPEED);  // wrapped
  CHECK(run(m, now + JOG_PULSE_MS) == 0);
}

static void test_reverse_ramp() {
  SCENARIO("reverse ramp");
  MotorCore m;
  uint32_t now = 1000;

  // Forward, then backward straight away: slows to 0, then reverses.
  m.command(drive(JOG_SPEED, JOG_PULSE_MS), now);
  CHECK(run(m, now) == JOG_SPEED);
  uint32_t t0 = now += 100;
  DriveCommand back = drive(-JOG_SPEED, JOG_PULSE_MS);
  m.command(back, t0);
  int16_t last = run(m, t0);
  CHECK(last == JOG_SPEED);  // the ramp starts from the speed it had
  for (uint32_t t = t0 + MOTOR_LOOP_MS; t < t0 + REVERSE_RAMP_MS; t += MOTOR_LOOP_MS) {
    int16_t out = run(m, t);
    CHECK(out >= 0 && out <= last);  // still the old way, never faster
    last = out;
  }
  CHECK(last < JOG_SPEED / 4);
  CHECK(run(m, t0 + REVERSE_RAMP_MS) == -JOG_SPEED);
  // duration_ms counts from receipt, ramp included.
  CHECK(run(m, t0 + JOG_PULSE_MS - 1) == -JOG_SPEED);
  CHECK(run(m, t0 + JOG_PULSE_MS) == 0 && m.done_seq() == back.seq);

  // Backward to forward ramps the same way.
  now = 10000;
  halt(m, now);
  m.command(drive(-CRUISE_SPEED), now);
  run(m, now);
  m.command(drive(CRUISE_SPEED), now);
  int16_t mid = run(m, now + REVERSE_RAMP_MS / 2);
  CHECK(mid < 0 && mid > -CRUISE_SPEED);
  CHECK(run(m, now + REVERSE_RAMP_MS) == CRUISE_SPEED);

  // A stop during the ramp stops at once.
  now = 20000;
  halt(m, now);
  m.command(drive(CRUISE_SPEED), now);
  run(m, now);
  m.command(drive(-CRUISE_SPEED), now);
  CHECK(run(m, now + 10) > 0);
  m.command(stop(), now + 20);
  CHECK(run(m, now + 20) == 0 && run(m, now + REVERSE_RAMP_MS) == 0);

  // A second command the new way mid-ramp doesn't restart the ramp.
  now = 30000;
  halt(m, now);
  m.command(drive(CRUISE_SPEED), now);
  run(m, now);
  m.command(drive(-CRUISE_SPEED), now);
  run(m, now + REVERSE_RAMP_MS / 2);
  m.command(drive(-APPROACH_SPEED), now + REVERSE_RAMP_MS / 2);
  CHECK(run(m, now + REVERSE_RAMP_MS / 2) > 0);
  CHECK(run(m, now + REVERSE_RAMP_MS) == -APPROACH_SPEED);

  // Changing its mind mid-ramp: carries on the way it was going.
  now = 40000;
  halt(m, now);
  m.command(drive(CRUISE_SPEED), now);
  run(m, now);
  m.command(drive(-CRUISE_SPEED), now);
  run(m, now + REVERSE_RAMP_MS / 2);
  m.command(drive(CRUISE_SPEED), now + REVERSE_RAMP_MS / 2);
  CHECK(run(m, now + REVERSE_RAMP_MS / 2) == CRUISE_SPEED);
  CHECK(run(m, now + REVERSE_RAMP_MS * 2) == CRUISE_SPEED);
}

static void test_safety_flags() {
  SCENARIO("safety flags");
  MotorCore m;
  uint32_t now = 1000;

  // The kill flag stops it both ways, for as long as it is set.
  m.command(drive(CRUISE_SPEED), now);
  CHECK(run(m, now) == CRUISE_SPEED);
  CHECK(m.update(now += 5, true, false, false) == 0 && m.held());
  CHECK(m.update(now += 5000, true, false, false) == 0);
  CHECK(run(m, now += 5) == CRUISE_SPEED && !m.held());  // the command carries on
  m.command(drive(-CRUISE_SPEED), now);
  CHECK(m.update(now + REVERSE_RAMP_MS, true, false, false) == 0);
  CHECK(run(m, now + REVERSE_RAMP_MS + 5) == -CRUISE_SPEED);

  // An obstacle in front stops forward driving, not reversing.
  now = 10000;
  halt(m, now);
  m.command(drive(CRUISE_SPEED), now);
  CHECK(m.update(now, false, true, false) == 0 && m.held());
  CHECK(m.update(now, false, false, true) == CRUISE_SPEED && !m.held());  // behind: irrelevant
  halt(m, now);
  m.command(drive(-CRUISE_SPEED), now);
  CHECK(m.update(now, false, true, false) == -CRUISE_SPEED);  // backing away from it
  CHECK(m.update(now, false, false, true) == 0 && m.held());
  CHECK(m.update(now, false, false, false) == -CRUISE_SPEED);

  // A stopped motor isn't "held": there's nothing to hold.
  m.command(stop(), now);
  CHECK(m.update(now, false, true, true) == 0 && !m.held());

  // An obstacle during the ramp stops it at once, on the side it's still
  // moving toward. Then it backs away with no ramp left to run.
  now = 20000;
  halt(m, now);
  m.command(drive(CRUISE_SPEED), now);
  run(m, now);
  m.command(drive(-CRUISE_SPEED), now);
  CHECK(run(m, now + 10) > 0);
  CHECK(m.update(now + 20, false, true, false) == 0);
  CHECK(m.update(now + 25, false, true, false) == -CRUISE_SPEED);
  // The rear flag doesn't cut the ramp short, but holds the reversal after it.
  now = 30000;
  halt(m, now);
  m.command(drive(CRUISE_SPEED), now);
  run(m, now);
  m.command(drive(-CRUISE_SPEED), now);
  CHECK(m.update(now + 10, false, false, true) > 0);
  CHECK(m.update(now + REVERSE_RAMP_MS, false, false, true) == 0 && m.held());

  // A timed Drive still runs out while held: a jog into a wall ends.
  now = 40000;
  halt(m, now);
  DriveCommand jog = drive(JOG_SPEED, JOG_PULSE_MS);
  m.command(jog, now);
  CHECK(m.update(now, false, true, false) == 0);
  CHECK(m.update(now + JOG_PULSE_MS, false, true, false) == 0 && m.done_seq() == jog.seq);
  CHECK(run(m, now + JOG_PULSE_MS + 5) == 0 && !m.held());

  // A stop always gets through while held.
  m.command(drive(CRUISE_SPEED), now);
  m.update(now, true, false, false);
  m.command(stop(), now);
  CHECK(run(m, now) == 0);
}

int main() {
  test_commands();
  test_timed_drive();
  test_reverse_ramp();
  test_safety_flags();
  printf("motor_test: %s\n", failures ? "FAILED" : "passed");
  return failures ? 1 : 0;
}
