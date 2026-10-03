// task_context.h
// What the nav task holds about its work (docs/firmware-architecture.md,
// "Task context"). Pure C++ with no Arduino or FreeRTOS calls, so test_host
// can build it.
//
// RAM only: it survives a lost network or Pi outage, not a reboot. A rebooted
// robot starts with no task and the orchestrator requeues it.

#pragma once

#include <stdint.h>

#include "../graph.h"
#include "../types.h"

// One task from a navigate command. task_id "" means none.
struct TaskSpec {
  char task_id[TASK_ID_LEN];
  NodeIndex target;        // NO_NODE when there's no task
  TargetAction action;
  uint32_t duration_ms;    // per-action default from config.h already applied
};

struct TaskContext {
  // Current task. A dock task is a task_id adopted from return_to_dock: it
  // completes once the robot connects to the charger.
  TaskSpec current;
  bool dock_task;
  NodeIndex path[MAX_PATH_LEN];
  uint8_t path_len;
  uint8_t path_index;          // path[path_index] is the last node reached
  uint32_t action_started_ms;  // millis() when `working` began

  // Task interrupted by a trip to the dock, resumed (re-planned from the
  // dock) after charging. Telemetry keeps reporting its task_id meanwhile.
  TaskSpec kept;

  // Status `stop` interrupted, restored by `resume`. None after a dock trip
  // ends in `stopped`: resume then continues the kept task, if any.
  bool has_paused_status;
  RobotStatus paused_status;
  uint32_t paused_at_ms;       // holds the action timer while stopped

  // Set by stop, cleared by resume or navigate. Survives dock trips and
  // manual timeouts.
  bool stop_latched;

  // Last task completed successfully, "" if none since boot.
  char last_completed_task_id[TASK_ID_LEN];
};
