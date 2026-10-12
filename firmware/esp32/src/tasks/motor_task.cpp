// motor_task.cpp
// See motor_task.h.

#include "motor_task.h"

#include <Arduino.h>

#include "../config.h"
#include "../drivers/motor_driver.h"
#include "../log.h"
#include "../motor/motor_core.h"
#include "../types.h"

void motor_task(void* /*param*/) {
  motor_driver_begin();
  MotorCore core;
  int16_t applied = 0;
  uint32_t done_seq = 0;
  bool held = false;

  for (;;) {
    // Wakes at once for a new command; otherwise this is the cycle period.
    DriveCommand c;
    if (xQueueReceive(g_drive_queue, &c, pdMS_TO_TICKS(MOTOR_LOOP_MS)) == pdTRUE) {
      core.command(c, millis());
      switch (c.mode) {
        case DriveMode::Stop:
          LOG("motor", "#%lu stop", (unsigned long)c.seq);
          break;
        case DriveMode::Drive:
          LOG("motor", "#%lu drive %d for %lu ms", (unsigned long)c.seq, c.left_speed,
              (unsigned long)c.duration_ms);
          break;
        case DriveMode::Turn:
          LOG("motor", "#%lu turn ignored: one drive motor, stopping", (unsigned long)c.seq);
          break;
      }
    }

    int16_t speed = core.update(millis(), g_motor_kill_flag, g_obstacle_front_flag,
                                g_obstacle_rear_flag);
    if (speed != applied) {
      motor_driver_set(speed);
      applied = speed;
    }
    if (core.done_seq() != done_seq) {
      done_seq = core.done_seq();
      g_drive_done_seq = done_seq;
    }
    if (core.held() != held) {
      held = core.held();
      if (held) {
        LOG("motor", "held off: %s", g_motor_kill_flag ? "motor cutoff" : "obstacle");
      } else {
        LOG("motor", "released");
      }
    }
  }
}
