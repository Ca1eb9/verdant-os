// pad_test.cpp
// Drives the controller rules (src/pad/pad_core) on a laptop: the stick's
// deadzone, speed and drive repeat, the centre-first rule, and the two buttons.
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

static bool drives(PadCore& p, float stick, uint32_t now, int16_t speed) {
  return p.update(stick, false, false, now) == PadAction::Drive && p.speed() == speed;
}

static void test_stick() {
  SCENARIO("stick");
  uint32_t now = 1000;
  PadCore p = centred(now);

  // Speed from how far it's pushed: nothing inside the deadzone, then from
  // PAD_MIN_SPEED just past it to PAD_MAX_SPEED fully pushed.
  CHECK(p.update(PAD_DEADZONE, false, false, now += 40) == PadAction::None);
  CHECK(drives(p, PAD_DEADZONE + 0.001f, now += 40, PAD_MIN_SPEED));
  CHECK(drives(p, UP, now += 40, PAD_MAX_SPEED));
  CHECK(drives(p, 1.2f, now += PAD_DRIVE_INTERVAL_MS, PAD_MAX_SPEED));  // past full: clamped
  CHECK(drives(p, (1 + PAD_DEADZONE) / 2, now += PAD_DRIVE_INTERVAL_MS,
               (PAD_MIN_SPEED + PAD_MAX_SPEED) / 2));  // half way

  // Held: a drive every PAD_DRIVE_INTERVAL_MS, nothing in between.
  CHECK(drives(p, UP, now += 40, PAD_MAX_SPEED));
  uint32_t t0 = now;
  int sent = 0;
  for (now += PAD_LOOP_MS; now - t0 <= PAD_DRIVE_INTERVAL_MS * 5; now += PAD_LOOP_MS) {
    if (p.update(UP, false, false, now) == PadAction::Drive) sent++;
  }
  CHECK(sent >= 4 && sent <= 5);  // the loop's ticks don't land on the interval
  CHECK(PAD_DRIVE_INTERVAL_MS + PAD_LOOP_MS < PAD_PULSE_MS);  // or the robot stutters
  CHECK(PAD_PULSE_MS < JOG_PULSE_MS);  // stops sooner than a dashboard jog

  // A small change waits for the interval; PAD_SPEED_STEP or more goes at once.
  float step = (float)PAD_SPEED_STEP / (PAD_MAX_SPEED - PAD_MIN_SPEED) * (1 - PAD_DEADZONE);
  PadCore q = centred(now);
  CHECK(q.update(0.6f, false, false, now += 40) == PadAction::Drive);
  int16_t first = q.speed();
  CHECK(q.update(0.6f + step / 2, false, false, now += 40) == PadAction::None);
  CHECK(q.update(0.6f + step * 1.1f, false, false, now += 1) == PadAction::Drive);
  CHECK(q.speed() - first >= PAD_SPEED_STEP);

  // Centred: nothing. Straight through the centre to the other way: at once.
  CHECK(p.update(REST, false, false, now += 40) == PadAction::None);
  CHECK(p.update(REST, false, false, now += 1000) == PadAction::None);
  CHECK(drives(p, DOWN, now += 40, -PAD_MAX_SPEED));
  CHECK(drives(p, UP, now += 1, PAD_MAX_SPEED));
  CHECK(drives(p, DOWN, now += 1, -PAD_MAX_SPEED));

  // millis() wrapping while held doesn't stop the drives.
  now = UINT32_MAX - 50;
  PadCore w = centred(now);
  CHECK(drives(w, UP, now += 40, PAD_MAX_SPEED));
  CHECK(drives(w, UP, now += PAD_DRIVE_INTERVAL_MS, PAD_MAX_SPEED));
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
  CHECK(p.update(UP, false, false, now += 40) == PadAction::Drive);

  // The link stalled while it was held (reset): same again.
  p.reset();
  CHECK(p.update(UP, false, false, now += 40) == PadAction::None);
  CHECK(p.update(REST, false, false, now += 40) == PadAction::None);
  CHECK(p.update(UP, false, false, now += 40) == PadAction::Drive);
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
  CHECK(p.update(UP, false, false, now += 40) == PadAction::Drive);
  CHECK(p.update(UP, true, false, now += 40) == PadAction::Stop);
  CHECK(p.update(UP, false, false, now += PAD_DRIVE_INTERVAL_MS) == PadAction::None);
  CHECK(p.update(DOWN, false, false, now += 40) == PadAction::None);
  CHECK(p.update(REST, false, false, now += 40) == PadAction::None);
  CHECK(p.update(DOWN, false, false, now += 40) == PadAction::Drive);

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
