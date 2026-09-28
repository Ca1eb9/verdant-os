// ============================================================
// State machine — pure functions, no MQTT, no I/O
//
// Each handler takes the robot's current state and an input,
// returns the (possibly changed) state and a list of side
// effects for the orchestrator to execute.
//
// To add or change a transition, edit the relevant handler
// function below. Each state has exactly one handler.
// ============================================================

import {
  type RobotState,
  type RobotTelemetry,
  type RobotEvent,
  type RobotCommand,
  type OrchestratorConfig,
  RobotStatus,
  RobotEventType,
  AlertSeverity,
  TaskPriority,
  CommandSource,
} from "@farm/shared";

// --- Side effect types ---------------------------------------
// The orchestrator loop reads these and performs the actual I/O.

export type SideEffect =
  | { type: "send_command"; robotId: string; command: RobotCommand }
  | { type: "publish_alert"; robotId: string; severity: AlertSeverity; message: string }
  | { type: "complete_task" }
  | { type: "fail_task"; error: string }
  | { type: "requeue_task" }
  | { type: "request_next_task" };

type Result = { state: RobotState; effects: SideEffect[] };

// --- Telemetry processing ------------------------------------
// Called on every telemetry message. Updates tracking fields
// and checks battery thresholds.
// Robot telemetry should be taken as truth - including state

export function processTelemetry(
  state: RobotState,
  msg: RobotTelemetry,
  config: OrchestratorConfig,
  now: number,
  /** A stop task is queued or assigned for this robot */
  stopPending: boolean
): Result {
  const effects: SideEffect[] = [];
  const prev = { ...state };

  // Always update tracking fields (last_seen is set on receipt by the caller)
  state.current_node = msg.current_node;
  state.battery_pct = msg.battery_pct;
  state.heading = msg.heading;

  if (msg.status !== state.status) {
    state.status = msg.status as RobotStatus;
  }

  // Manual driving leaves the planned route: drop it so the tags it passes
  // aren't deviations. It's rebuilt from where the robot is when it resumes.
  if (state.status === RobotStatus.MANUAL) {
    state.expected_path = [];
    state.waypoints_hit = [];
  }

  // Track waypoint progress while en route
  if (
    state.status === RobotStatus.EN_ROUTE &&
    state.expected_path.length > 0 &&
    state.current_node !== null &&
    !state.waypoints_hit.includes(state.current_node)
  ) {
    state.waypoints_hit.push(state.current_node);
    if (!state.expected_path.includes(state.current_node)) {
      effects.push({
        type: "publish_alert",
        robotId: state.id,
        severity: AlertSeverity.WARNING,
        message: `Robot deviated from expected path at ${state.current_node}`,
      });
    }
  }

  // Recovery: if the robot was lost and telemetry resumes, it's back.
  // Its task is reconciled below like any other telemetry.
  if (prev.status === RobotStatus.LOST && state.status !== RobotStatus.LOST) {
    effects.push({
      type: "publish_alert",
      robotId: state.id,
      severity: AlertSeverity.INFO,
      message: `Robot recovered at ${state.current_node ?? "unknown node"}`,
    });
  }

  // Reconcile the assigned task against the robot's reported task.
  // The robot keeps its task_id through dock detours and overrides, so
  // only requeue when it reports no task after the grace period.
  const task = state.assigned_task;
  if (task) {
    if (
      // Robot finished it but the task_complete event was lost
      msg.last_completed_task_id === task.task_id ||
      (task.type === "stop" && state.status === RobotStatus.STOPPED) ||
      (task.type === "return_to_dock" &&
        (state.status === RobotStatus.DOCKING || state.status === RobotStatus.CHARGING))
    ) {
      state.expected_path = [];
      state.waypoints_hit = [];
      effects.push({ type: "complete_task" });
    } else if (!msg.task_id && now - (task.assigned_at ?? 0) > config.command_ack_timeout_ms) {
      state.expected_path = [];
      state.waypoints_hit = [];
      effects.push({ type: "requeue_task" });
    }
  }

  if (state.status === RobotStatus.RETURNING_TO_DOCK ||
      state.status === RobotStatus.DOCKING ||
      state.status === RobotStatus.CHARGING
  ) {
    state.dock_requested_at = null;
  }

  // Battery preemption — only when idle or on a task. Idle robots use the
  // assignment threshold so a robot too low to take work still goes to charge.
  // A pending stop wins; only firmware survival overrides can override it.
  const dockThreshold = state.status === RobotStatus.IDLE
    ? config.battery_low_pct + config.battery_assign_margin_pct
    : config.battery_low_pct;
  if (!stopPending &&
      state.battery_pct <= dockThreshold &&
      (state.status === RobotStatus.IDLE ||
       state.status === RobotStatus.EN_ROUTE ||
       state.status === RobotStatus.WORKING)
  ) {
    // Send once, then only resend if the robot hasn't acted on it
    if (state.dock_requested_at !== null &&
        now - state.dock_requested_at <= config.command_ack_timeout_ms) {
      return { state, effects };
    }
    const firstRequest = state.dock_requested_at === null;
    state.dock_requested_at = now;

    effects.push({
      type: "send_command",
      robotId: state.id,
      command: {
        command: "return_to_dock",
        priority: TaskPriority.CRITICAL,
        source: CommandSource.SCHEDULER,
      },
    });
    if (firstRequest && state.battery_pct <= config.battery_critical_pct) {
      effects.push({
        type: "publish_alert",
        robotId: state.id,
        severity: AlertSeverity.CRITICAL,
        message: `Battery critical (${msg.battery_pct}%), returning to dock`,
      });
    }

    return { state, effects };
  }

  // Robot reports idle: give it the next task (no-op if it already has one)
  if (state.status === RobotStatus.IDLE) {
    effects.push({ type: "request_next_task" });
  }

  return { state, effects };
}

// --- Event processing ----------------------------------------
// Called when a discrete RobotEvent arrives. Runs the state
// machine transition for the robot's current status.

export function processEvent(
  state: RobotState,
  event: RobotEvent,
  config: OrchestratorConfig
): Result {
  // Error events override from any state
  if (event.event === RobotEventType.ERROR) {
    return handleErrorEvent(state, event);
  }

  // Recovery event, even if telemetry already moved the robot out of error
  if (event.event === RobotEventType.RECOVERY) {
    return handleRecovery(state, event);
  }

  // Task events only apply to the task we assigned, whatever status we
  // last stored (telemetry and events can arrive in either order)
  if (
    event.event === RobotEventType.TASK_COMPLETE ||
    event.event === RobotEventType.TASK_FAILED
  ) {
    if (!state.assigned_task || event.task_id !== state.assigned_task.task_id) {
      return { state, effects: [] };
    }
    if (state.status !== RobotStatus.EN_ROUTE) {
      return handleEventWorking(state, event);
    }
  }

  // Dispatch to per-state handler
  switch (state.status) {
    case RobotStatus.IDLE:
      return handleEventIdle(state, event);
    case RobotStatus.EN_ROUTE:
      return handleEventEnRoute(state, event);
    case RobotStatus.WORKING:
      return handleEventWorking(state, event);
    case RobotStatus.RETURNING_TO_DOCK:
      return handleEventReturning(state, event);
    case RobotStatus.DOCKING:
      return handleEventDocking(state, event);
    case RobotStatus.CHARGING:
      return handleEventCharging(state, event);
    default:
      // LOST and ERROR — events are mostly ignored, recovery handled above
      return { state, effects: [] };
  }
}

// --- Per-state event handlers --------------------------------

function handleEventIdle(state: RobotState, event: RobotEvent): Result {
  // Nothing meaningful happens in idle from robot events.
  // Task assignment is initiated by the orchestrator, not by events.
  return { state, effects: [] };
}

function handleEventEnRoute(state: RobotState, event: RobotEvent): Result {
  const effects: SideEffect[] = [];

  if (event.event === RobotEventType.ARRIVED) {
    return { state, effects };
  }

  if (event.event === RobotEventType.TASK_FAILED) {
    effects.push({
      type: "fail_task",
      error: event.details ?? "Failed during navigation",
    });
    effects.push({
      type: "publish_alert",
      robotId: state.id,
      severity: AlertSeverity.WARNING,
      message: `Task failed during navigation: ${event.details ?? "unknown"}`,
    });
    effects.push({ type: "request_next_task" });
    return { state, effects };
  }

  if (event.event === RobotEventType.PATH_BLOCKED) {
    effects.push({
      type: "publish_alert",
      robotId: state.id,
      severity: AlertSeverity.WARNING,
      message: `Path blocked at ${event.node_id}`,
    });
    // If it stays blocked, the watchdog will catch the silence.
    return { state, effects };
  }

  return { state, effects };
}

function handleEventWorking(state: RobotState, event: RobotEvent): Result {
  const effects: SideEffect[] = [];

  if (event.event === RobotEventType.TASK_COMPLETE) {
    state.expected_path = [];
    state.waypoints_hit = [];
    effects.push({ type: "complete_task" });
    effects.push({ type: "request_next_task" });
    return { state, effects };
  }

  if (event.event === RobotEventType.TASK_FAILED) {
    state.expected_path = [];
    state.waypoints_hit = [];
    effects.push({
      type: "fail_task",
      error: event.details ?? "Failed during work",
    });
    effects.push({
      type: "publish_alert",
      robotId: state.id,
      severity: AlertSeverity.WARNING,
      message: `Task failed: ${event.details ?? "unknown"}`,
    });
    effects.push({ type: "request_next_task" });
    return { state, effects };
  }

  return { state, effects };
}

function handleEventReturning(state: RobotState, event: RobotEvent): Result {
  const effects: SideEffect[] = [];

  if (event.event === RobotEventType.ARRIVED) {
    return { state, effects };
  }

  return { state, effects };
}

function handleEventDocking(state: RobotState, event: RobotEvent): Result {
  const effects: SideEffect[] = [];

  if (event.event === RobotEventType.DOCK_CONNECTED) {
    return { state, effects };
  }

  return { state, effects };
}

function handleEventCharging(state: RobotState, event: RobotEvent): Result {
  const effects: SideEffect[] = [];

  if (event.event === RobotEventType.CHARGE_COMPLETE) {
    effects.push({ type: "request_next_task" });
    return { state, effects };
  }

  return { state, effects };
}

// --- Cross-cutting handlers ----------------------------------

function handleErrorEvent(state: RobotState, event: RobotEvent): Result {
  const effects: SideEffect[] = [];
  const prevStatus = state.status;

  // Task and path are kept; telemetry reconciliation requeues it if the robot drops it

  effects.push({
    type: "publish_alert",
    robotId: state.id,
    severity: AlertSeverity.CRITICAL,
    message: `Robot error (was ${prevStatus}): ${event.details ?? "unknown"}`,
  });

  return { state, effects };
}

function handleRecovery(state: RobotState, event: RobotEvent): Result {
  const effects: SideEffect[] = [];

  effects.push({
    type: "publish_alert",
    robotId: state.id,
    severity: AlertSeverity.INFO,
    message: `Robot recovered from error at ${event.node_id}`,
  });
  effects.push({ type: "request_next_task" });

  return { state, effects };
}

// --- Watchdog ------------------------------------------------
// Called periodically. Returns effects only if the robot has
// gone silent for longer than the configured timeout.

export function processWatchdog(
  state: RobotState,
  now: number,
  config: OrchestratorConfig
): Result {
  const effects: SideEffect[] = [];

  // Don't watchdog robots already lost
  if (state.status === RobotStatus.LOST) {
    return { state, effects };
  }

  const silence = now - state.last_seen;
  if (silence > config.heartbeat_timeout_ms) {
    const prevStatus = state.status;

    // Keep the task and path: the robot may still be on it. Its telemetry
    // decides what happens to the task once it reconnects.
    state.status = RobotStatus.LOST;

    effects.push({
      type: "publish_alert",
      robotId: state.id,
      severity: AlertSeverity.CRITICAL,
      message: `No heartbeat for ${Math.round(silence / 1000)}s (was ${prevStatus})`,
    });
  }

  return { state, effects };
}
