// ============================================================
// Orchestrator — entry point
//
// Subscribes to robot telemetry and events, maintains state
// per robot, runs the state machine, and publishes commands.
//
// Run:  npx tsx src/index.ts
// ============================================================

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import {
  type FarmTopology,
  type RobotTelemetry,
  type RobotEvent,
  type RobotCommand,
  type RobotState,
  type FarmTask,
  type FarmAlert,
  type RemoteCommand,
  RobotStatus,
  RobotEventType,
  Heading,
  AlertSeverity,
  TaskStatus,
  TaskPriority,
  CommandSource,
  TOPICS,
  extractIdFromTopic,
  buildGraph,
  dijkstra,
  type NavGraph,
  createMqttClient,
  type TypedMqttClient,
} from "@farm/shared";

import { loadConfig } from "./config.js";
import { TaskQueue } from "./task-queue.js";
import {
  processTelemetry,
  processEvent,
  processWatchdog,
  type SideEffect,
} from "./state-machine.js";
import { isRobotTelemetry, isRobotEvent, isRemoteCommand } from "./validate.js";

// --- Config & topology ---------------------------------------

const CONFIG_PATH = process.env.CONFIG_PATH ?? "../../orchestrator-config.json";
const TOPOLOGY_PATH = process.env.TOPOLOGY_PATH ?? "../../topology.json";
const BROKER_URL = process.env.BROKER_URL ?? "mqtt://localhost:1883";

const config = loadConfig(fileURLToPath(new URL(CONFIG_PATH, import.meta.url)));
const topology: FarmTopology = JSON.parse(
  readFileSync(new URL(TOPOLOGY_PATH, import.meta.url), "utf-8")
);
const graph = buildGraph(topology);
const nodeIds: ReadonlySet<string> = new Set(graph.nodes.keys());
const completedTasks: FarmTask[] = []

/** Keep finished tasks, dropping the oldest past the configured limit */
function recordFinished(task: FarmTask) {
  completedTasks.push(task);
  if (completedTasks.length > config.completed_task_limit) {
    completedTasks.shift();
  }
}

const robots = new Map<string, RobotState>();
const queue = new TaskQueue();
let mqtt: TypedMqttClient;

function getOrCreateRobot(robotId: string): RobotState {
  let state = robots.get(robotId);
  if (!state) {
    state = {
      id: robotId,
      status: RobotStatus.INITIALIZING,
      current_node: null,
      heading: null,
      battery_pct: 100,
      assigned_task: null,
      expected_path: [],
      waypoints_hit: [],
      last_seen: Date.now(),
      dock_requested_at: null,
    };
    robots.set(robotId, state);
    console.log(`[ORCH] Tracking new robot: ${robotId}`);
  }
  return state;
}

// --- Side effect execution --------------
// The state machine returns pure descriptions of what should
// happen. This function does the actual I/O.

function executeEffects(robotId: string, effects: SideEffect[]) {
  for (const effect of effects) {
    switch (effect.type) {
      case "send_command": {
        mqtt.publish(TOPICS.robot.command(effect.robotId), effect.command);
        console.log(
          `[CMD] → ${effect.robotId}: ${effect.command.command}` +
          (effect.command.target_node ? ` → ${effect.command.target_node}` : "")
        );
        break;
      }

      case "publish_alert": {
        const alert: FarmAlert = {
          alert_id: randomUUID(),
          severity: effect.severity,
          source: effect.robotId,
          source_type: "robot",
          message: effect.message,
          metric: "",
          value: 0,
          threshold: 0,
          timestamp: Date.now(),
        };
        mqtt.publish(TOPICS.alerts, alert);
        console.log(`[ALERT] ${effect.message}`);
        break;
      }

      case "complete_task": {
        const state = robots.get(robotId);
        if (state?.assigned_task) {
          state.assigned_task.status = TaskStatus.COMPLETED;
          state.assigned_task.completed_at = Date.now();
          recordFinished(state.assigned_task);
          console.log(`[TASK] ${state.assigned_task.task_id} completed`);
          state.assigned_task = null;
        }
        break;
      }

      case "fail_task": {
        const state = robots.get(robotId);
        if (state?.assigned_task) {
          state.assigned_task.status = TaskStatus.FAILED;
          state.assigned_task.error = effect.error;
          recordFinished(state.assigned_task);
          console.log(`[TASK] ${state.assigned_task.task_id} failed: ${effect.error}`);
          state.assigned_task = null;
        }
        break;
      }

      case "requeue_task": {
        const state = robots.get(robotId);
        if (state?.assigned_task) {
          console.log(`[TASK] ↺ ${state.assigned_task.task_id} requeued`);
          queue.requeue(state.assigned_task);
          state.assigned_task = null;
        }
        break;
      }

      case "request_next_task": {
        tryAssignTask(robotId);
        break;
      }
    }
  }
}

// --- Task assignment -----------------------------------------

function tryAssignTask(robotId: string) {
  const state = robots.get(robotId);
  if (!state) return;
  if (state.status !== RobotStatus.IDLE) return;
  if (state.assigned_task) return;
  if (state.current_node === null) return; // hasn't read a tag yet
  if (state.battery_pct <= config.battery_low_pct + config.battery_assign_margin_pct) return; // needs charging first

  // First task this robot may take; tasks pinned to other robots don't block it
  const task = queue.all().find((t) => !t.pinned_robot || t.pinned_robot === robotId);
  if (!task) return;
  queue.remove(task.task_id);

  dispatchTask(state, task);
}

/** Assign a task to a robot and send it the matching command */
function dispatchTask(state: RobotState, task: FarmTask) {
  const robotId = state.id;

  // Already at a dock: nothing to do
  if (
    task.type === "return_to_dock" &&
    state.current_node !== null &&
    graph.nodes.get(state.current_node)?.type === "dock"
  ) {
    task.status = TaskStatus.COMPLETED;
    task.completed_at = Date.now();
    recordFinished(task);
    console.log(`[TASK] ${task.task_id} completed (${robotId} already at dock)`);
    return;
  }

  let command: RobotCommand;
  let path: string[] = [];

  if (task.type === "stop" || task.type === "return_to_dock") {
    command = {
      command: task.type,
      task_id: task.task_id,
      priority: task.priority,
      source: task.source,
    };
  } else {
    // Compute path from robot's current position to target
    const found = state.current_node !== null && task.target_node
      ? dijkstra(graph, state.current_node, task.target_node)
      : null;
    if (!found || found.length < 1) {
      // Topology is static, so retrying won't help
      task.status = TaskStatus.FAILED;
      task.error = `No path from ${state.current_node} to ${task.target_node}`;
      recordFinished(task);
      executeEffects(robotId, [{
        type: "publish_alert",
        robotId,
        severity: AlertSeverity.WARNING,
        message: `Task ${task.task_id} failed: ${task.error}`,
      }]);
      return;
    }
    path = found;
    command = {
      command: "navigate",
      task_id: task.task_id,
      path: task.include_path ? path : undefined,
      target_node: task.target_node,
      action_at_target: task.type === "custom" ? "idle" : task.type,
      duration_ms: task.duration_ms,
      priority: task.priority,
      source: task.source,
    };
  }

  // Update state
  task.status = TaskStatus.ASSIGNED;
  task.assigned_robot = robotId;
  task.assigned_at = Date.now();
  state.assigned_task = task;
  state.expected_path = path;
  state.waypoints_hit = [];

  mqtt.publish(TOPICS.robot.command(robotId), command);
  console.log(
    `[ORCH] Assigned ${task.task_id} to ${robotId}: ${task.type}` +
    (task.target_node && command.command === "navigate"
      ? ` at ${task.target_node} (${path.length} hops)`
      : "")
  );
}

/** Build a queued task from a remote command */
function remoteTask(msg: RemoteCommand, taskId: string): FarmTask {
  const c = msg.command;
  const action = c.action_at_target;
  return {
    task_id: taskId,
    type: c.command === "stop" || c.command === "return_to_dock"
      ? c.command
      : action === "water" || action === "grow" || action === "harvest" ? action : "custom",
    target_node: c.target_node,
    duration_ms: c.duration_ms,
    priority: c.priority ?? TaskPriority.NORMAL,
    source: CommandSource.REMOTE,
    created_at: Date.now(),
    status: TaskStatus.PENDING,
    pinned_robot: msg.robot_id,
    include_path: msg.include_path,
  };
}

// --- MQTT handlers -------------------------------------------

function onTelemetry(raw: unknown, topic: string) {
  if (!isRobotTelemetry(raw, nodeIds)) {
    console.warn(`[ORCH] Dropped invalid telemetry on ${topic}`);
    return;
  }
  const msg = raw;
  const robotId = extractIdFromTopic(topic) ?? msg.robot_id;
  const state = getOrCreateRobot(robotId);
  // Pi receive time; robot clocks aren't synced
  state.last_seen = Date.now();

  const { effects } = processTelemetry(state, msg, config, state.last_seen);
  executeEffects(robotId, effects);
}

function onEvent(raw: unknown, topic: string) {
  if (!isRobotEvent(raw)) {
    console.warn(`[ORCH] Dropped invalid event on ${topic}`);
    return;
  }
  const event = raw;
  const robotId = extractIdFromTopic(topic) ?? event.robot_id;
  const state = getOrCreateRobot(robotId);
  state.last_seen = Date.now();

  console.log(
    `[EVENT] ${robotId}: ${event.event}` +
    (event.details ? ` — ${event.details}` : "")
  );

  const { effects } = processEvent(state, event, config);
  executeEffects(robotId, effects);
}

function onRemoteCommand(raw: unknown, topic: string) {
  if (!isRemoteCommand(raw)) {
    console.warn(`[REMOTE] Dropped invalid command on ${topic}`);
    return;
  }
  const msg = raw;
  console.log(
    `[REMOTE] from ${msg.issued_by}: ${msg.command.command}` +
    (msg.robot_id ? ` -> ${msg.robot_id}` : "") +
    (msg.immediate ? " (immediate)" : "")
  );

  const targets = msg.robot_id
    ? [[msg.robot_id, robots.get(msg.robot_id)] as const].filter(([, s]) => s)
    : [...robots];

  // Resume is always immediate; stop and return_to_dock when flagged.
  // Skip the queue. Send to targeted robot or all robots.
  if (msg.command.command === "resume" ||
      ((msg.command.command === "stop" || msg.command.command === "return_to_dock") &&
        msg.immediate)
    ) {
    for (const [robotId] of targets) {
      mqtt.publish(TOPICS.robot.command(robotId), msg.command);
      console.log(`[REMOTE] → ${robotId}: ${msg.command.command}`);
    }
    return;
  }

  // Queued stop / return_to_dock: one pinned task per robot, carried
  // out once the robot finishes its current task
  if (msg.command.command === "stop" || msg.command.command === "return_to_dock") {
    for (const [robotId] of targets) {
      const task = remoteTask(msg, msg.robot_id ? msg.id : `${msg.id}-${robotId}`);
      task.pinned_robot = robotId;
      queue.push(task);
      console.log(`[QUEUE] +${task.task_id} (${task.type}) pinned to ${robotId}`);
      tryAssignTask(robotId);
    }
    return;
  }

  // --- Navigate commands -------------------------------------
  if (msg.command.command === "navigate" && msg.command.target_node) {
    if (!graph.nodes.has(msg.command.target_node)) {
      console.log(`[REMOTE] Unknown target node: ${msg.command.target_node}`);
      return;
    }

    // Immediate: compute path and send directly, no queue
    if (msg.immediate && msg.robot_id) {
      const state = robots.get(msg.robot_id);
      if (!state) {
        console.log(`[REMOTE] Unknown robot: ${msg.robot_id}`);
        return;
      }

      const path = state.current_node !== null
        ? dijkstra(graph, state.current_node, msg.command.target_node)
        : null;
      if (!path || path.length < 1) {
        console.log(`[REMOTE] No path from ${state.current_node} to ${msg.command.target_node}`);
        return;
      }

      // Replaces the current task, which goes back to the queue
      if (state.assigned_task) {
        console.log(`[TASK] ↺ ${state.assigned_task.task_id} requeued (immediate override)`);
        queue.requeue(state.assigned_task);
        state.assigned_task = null;
      }
      dispatchTask(state, remoteTask(msg, msg.id));
      return;
    }

    // Normal: create a task and queue it
    const task = remoteTask(msg, msg.id);
    queue.push(task);
    console.log(
      `[QUEUE] +${task.task_id} (${task.type} → ${task.target_node})` +
      (msg.robot_id ? ` pinned to ${msg.robot_id}` : "")
    );

    // Try to assign immediately if a robot is available
    if (msg.robot_id) {
      tryAssignTask(msg.robot_id);
    } else {
      for (const [robotId, state] of robots) {
        if (state.status === RobotStatus.IDLE && !state.assigned_task) {
          tryAssignTask(robotId);
        }
      }
    }
    return;
  }

  console.log(`[REMOTE] Unhandled command: ${msg.command.command}`);
}

// --- Watchdog ------------------------------------------------

function runWatchdog() {
  const now = Date.now();
  for (const [robotId, state] of robots) {
    const { effects } = processWatchdog(state, now, config);
    executeEffects(robotId, effects);
  }
}

// --- Main ----------------------------------------------------

async function main() {
  mqtt = await createMqttClient({
    serviceName: "orchestrator",
    brokerUrl: BROKER_URL,
  });

  console.log(`[ORCH] Orchestrator running`);
  console.log(`[ORCH]   broker:    ${BROKER_URL}`);
  console.log(`[ORCH]   topology:  ${topology.nodes.length} nodes, ${topology.edges.length} edges`);
  console.log(`[ORCH]   battery:   low=${config.battery_low_pct}% critical=${config.battery_critical_pct}%`);
  console.log(`[ORCH]   watchdog:  ${config.heartbeat_timeout_ms / 1000}s timeout`);
  console.log(`[ORCH]   queue:     ${queue.length} tasks`);

  // Subscribe to all robot telemetry
  mqtt.subscribe<unknown>(TOPICS.robot.telemetryAll, onTelemetry);

  // Subscribe to all robot events
  mqtt.subscribe<unknown>(TOPICS.robot.eventsAll, onEvent);

  // Subscribe to remote commands (from Supabase bridge)
  mqtt.subscribe<unknown>(TOPICS.commands.remote, onRemoteCommand);

  // Subscribe to local commands (from dashboard)
  mqtt.subscribe<unknown>(TOPICS.commands.local, onRemoteCommand);

  // Start watchdog timer
  setInterval(runWatchdog, config.watchdog_interval_ms);

  // --- Scheduler hook ----------------------------------------
  // When you add the plant scheduler module, import it here:
  //
  //   import { startScheduler } from "./scheduler.js";
  //   startScheduler(queue, robots, config);
  //
  // The scheduler pushes FarmTasks into the queue on plant-care
  // intervals. The orchestrator assigns them normally.
  // -------------------------------------------------------------

  // Status logging
  setInterval(() => {
    for (const [id, s] of robots) {
      console.log(
        `[STATUS] ${id}: ${s.status.padEnd(18)} ` +
        `node=${(s.current_node ?? "-").padEnd(12)} ` +
        `bat=${s.battery_pct}% ` +
        `task=${s.assigned_task?.task_id ?? "none"}`
      );
    }
    if (queue.length > 0) {
      console.log(`[QUEUE] ${queue.length} tasks pending`);
    }
  }, 10_000);

  process.on("SIGINT", async () => {
    console.log("[ORCH] Shutting down");
    await mqtt.disconnect();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("[FATAL] Orchestrator failed:", err);
  process.exit(1);
});
