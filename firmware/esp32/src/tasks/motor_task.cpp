// motor_task.cpp
// See motor_task.h. Placeholder: logs commands, drives nothing.

#include "motor_task.h"

#include <Arduino.h>

#include "../log.h"
#include "../types.h"

void motor_task(void* /*param*/) {
  for (;;) {
    DriveCommand c;
    if (xQueueReceive(g_drive_queue, &c, portMAX_DELAY) != pdTRUE) continue;
    switch (c.mode) {
      case DriveMode::Stop:
        LOG("motor", "#%lu stop", (unsigned long)c.seq);
        break;
      case DriveMode::Drive:
        LOG("motor", "#%lu drive L%d R%d for %lu ms (no motor driver yet)", (unsigned long)c.seq,
            c.left_speed, c.right_speed, (unsigned long)c.duration_ms);
        break;
      case DriveMode::Turn:
        LOG("motor", "#%lu turn %d (no motor driver yet)", (unsigned long)c.seq, (int)c.turn);
        break;
    }
  }
}
