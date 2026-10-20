// encoder.h
// The drive motor's quadrature encoder (optional, ENCODER_ASSIST_ENABLED),
// counted by the PCNT peripheral: in hardware, on every edge of A and B,
// with no interrupts. Wiring in docs/wiring/robot.md.

#pragma once

#include <stdint.h>

// Sets up PCNT unit 0 on PIN_ENCODER_A / PIN_ENCODER_B. Call once, from the
// nav task. False (and logged) if it can't: the robot runs on tags alone.
bool encoder_begin();

// Counts since the last call, forward positive. The hardware counter holds
// only 16 bits, so call it at least every second (every nav loop).
int32_t encoder_take_counts();
