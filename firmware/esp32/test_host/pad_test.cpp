// pad_test.cpp
// Drives the controller rules (src/pad/pad_core) on a laptop: the stick's
// deadzone and jog repeat, the centre-first rule, and the two buttons.
// Build + run with ./run.sh

#include <stdio.h>

#include "config.h"
#include "pad/pad_core.h"

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

static const float UP = 1.0f, DOWN = -1.0f, REST = -0.02f;  // a resting stick isn't exactly 0

// A pad that has seen a centred stick, as when the controller connects at rest.
static PadCore centred(uint32_t now) {
  PadCore p;
  p.reset();
  CHECK(p.update(REST, false, false, now) == PadAction::None);
  return p;
}

static void test_stick() {
  SCENARIO("stick");
  uint32_t now = 1000;
  PadCore p = centred(now);

  CHECK(p.update(PAD_DEADZONE - 0.1f, false, false, now += 40) == PadAction::None);
  CHECK(p.update(UP, false, false, now += 40) == PadAction::JogForward);
  // Held: a jog every PAD_JOG_INTERVAL_MS, nothing in between.
  uint32_t t0 = now;
  int jogs = 0;
  for (now += PAD_LOOP_MS; now - t0 <= PAD_JOG_INTERVAL_MS * 5; now += PAD_LOOP_MS) {
    if (p.update(UP, false, false, now) == PadAction::JogForward) jogs++;
  }
  CHECK(jogs == 5);
  CHECK(PAD_JOG_INTERVAL_MS + PAD_LOOP_MS < JOG_PULSE_MS);  // or the robot stutters
  CHECK(p.update(REST, false, false, now += 40) == PadAction::None);
  CHECK(p.update(REST, false, false, now += 1000) == PadAction::None);
  CHECK(p.update(DOWN, false, false, now += 40) == PadAction::JogBackward);
  // Straight through the centre to the other way: at once, not after the interval.
  CHECK(p.update(UP, false, false, now += 40) == PadAction::JogForward);
  CHECK(p.update(DOWN, false, false, now += 40) == PadAction::JogBackward);

  // millis() wrapping while held doesn't stop the jogs.
  now = UINT32_MAX - 50;
  PadCore w = centred(now);
  CHECK(w.update(UP, false, false, now += 40) == PadAction::JogForward);
  CHECK(w.update(UP, false, false, now += PAD_JOG_INTERVAL_MS) == PadAction::JogForward);
}

static void test_centre_first() {
  SCENARIO("centre first");
  uint32_t now = 1000;

  // Pushed when the controller connects: nothing until it's centred.
  PadCore p;
  p.reset();
  CHECK(p.update(UP, false, false, now) == PadAction::None);
  CHECK(p.update(UP, false, false, now += 1000) == PadAction::None);
  CHECK(p.update(DOWN, false, false, now += 40) == PadAction::None);
  CHECK(p.update(REST, false, false, now += 40) == PadAction::None);
  CHECK(p.update(UP, false, false, now += 40) == PadAction::JogForward);

  // The link stalled while it was held (reset): same again.
  p.reset();
  CHECK(p.update(UP, false, false, now += 40) == PadAction::None);
  CHECK(p.update(REST, false, false, now += 40) == PadAction::None);
  CHECK(p.update(UP, false, false, now += 40) == PadAction::JogForward);
}

static void test_buttons() {
  SCENARIO("buttons");
  uint32_t now = 1000;
  PadCore p = centred(now);

  // A press, not a hold or a release.
  CHECK(p.update(REST, true, false, now += 40) == PadAction::Stop);
  CHECK(p.update(REST, true, false, now += 40) == PadAction::None);
  CHECK(p.update(REST, false, false, now += 40) == PadAction::None);
  CHECK(p.update(REST, false, true, now += 40) == PadAction::Resume);
  CHECK(p.update(REST, false, true, now += 40) == PadAction::None);
  CHECK(p.update(REST, false, false, now += 40) == PadAction::None);
  // Both at once: stop wins.
  CHECK(p.update(REST, true, true, now += 40) == PadAction::Stop);
  CHECK(p.update(REST, false, false, now += 40) == PadAction::None);

  // Stop while driving ends it until the stick is centred again.
  CHECK(p.update(UP, false, false, now += 40) == PadAction::JogForward);
  CHECK(p.update(UP, true, false, now += 40) == PadAction::Stop);
  CHECK(p.update(UP, false, false, now += PAD_JOG_INTERVAL_MS) == PadAction::None);
  CHECK(p.update(DOWN, false, false, now += 40) == PadAction::None);
  CHECK(p.update(REST, false, false, now += 40) == PadAction::None);
  CHECK(p.update(DOWN, false, false, now += 40) == PadAction::JogBackward);

  // A button already down when the controller connects isn't a press.
  PadCore held;
  held.reset();
  CHECK(held.update(REST, true, true, now) == PadAction::None);
  CHECK(held.update(REST, true, true, now += 40) == PadAction::None);
  CHECK(held.update(REST, false, false, now += 40) == PadAction::None);
  CHECK(held.update(REST, true, false, now += 40) == PadAction::Stop);
}

int main() {
  test_stick();
  test_centre_first();
  test_buttons();
  printf("pad_test: %s\n", failures ? "FAILED" : "passed");
  return failures ? 1 : 0;
}
