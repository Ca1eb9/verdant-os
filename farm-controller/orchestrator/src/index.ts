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
  type RobotStateUpdate,
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
import { loadTasks, saveTasks } from "./persistence.js";

// --- Config & topology ---------------------------------------

const CONFIG_PATH = process.env.CONFIG_PATH ?? "../../orchestrator-config.json";
const TOPOLOGY_PATH = process.env.TOPOLOGY_PATH ?? "../../topology.json";
const BROKER_URL = process.env.BROKER_URL ?? "mqtt://localhost:1883";
const STATE_PATH = fileURLToPath(
  new URL(process.env.STATE_PATH ?? "../../orchestrator-state.json", import.meta.url)
);

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

/** Last time a cancel was sent to each robot, to avoid resending every message */
const cancelSentAt = new Map<string, number>();

function sendCancel(robotId: string, taskId: string) {
  const command: RobotCommand = {
    command: "cancel",
    task_id: taskId,
    priority: TaskPriority.CRITICAL,
    source: CommandSource.REMOTE,
  };
  mqtt.publish(TOPICS.robot.command(robotId), command);
  cancelSentAt.set(robotId, Date.now());
  console.log(`[CMD] → ${robotId}: cancel ${taskId}`);
}

function isCancelled(taskId: string): boolean {
  return completedTasks.some((t) => t.task_id === taskId && t.status === TaskStatus.CANCELLED);
}

/** True if a task with this id is queued, assigned, or recently finished */
function isKnownTask(taskId: string): boolean {
  return (
    queue.all().some((t) => t.task_id === taskId) ||
    [...robots.values()].some((s) => s.assigned_task?.task_id === taskId) ||
    completedTasks.some((t) => t.task_id === taskId)
  );
}

/** Last state published per robot, to publish only on change */
const publishedState = new Map<string, string>();

/** Publish the orchestrator's view of each robot (retained) when it changes */
function publishStates() {
  for (const [robotId, s] of robots) {
    const t = s.assigned_task;
    const update: Omit<RobotStateUpdate, "timestamp"> = {
      robot_id: robotId,
      status: s.status,
      task: t ? { task_id: t.task_id, type: t.type, target_node: t.target_node, status: t.status } : null,
      expected_path: s.expected_path,
    };
    const key = JSON.stringify(update);
    if (publishedState.get(robotId) === key) continue;
    publishedState.set(robotId, key);
    mqtt.publish(TOPICS.robot.state(robotId), { ...update, timestamp: Date.now() }, true);
  }
}

function persist() {
  saveTasks(STATE_PATH, {
    queue: [...queue.all()],
    assigned: [...robots.values()].flatMap((s) => (s.assigned_task ? [s.assigned_task] : [])),
    finished: completedTasks,
  });
}

/** Wrap a handler so task state is saved and published after it runs */
function persisting<A extends unknown[]>(fn: (...args: A) => void) {
  return (...args: A) => {
    fn(...args);
    persist();
    publishStates();
  };
}

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
        // Robot dropped the task: retry up to max_task_retries, then fail it
        const state = robots.get(robotId);
        const task = state?.assigned_task;
        if (state && task) {
          task.retries = (task.retries ?? 0) + 1;
          if (task.retries > config.max_task_retries) {
            executeEffects(robotId, [
              { type: "fail_task", error: `Dropped by robot ${task.retries} times` },
              {
                type: "publish_alert",
                robotId,
                severity: AlertSeverity.WARNING,
                message: `Task ${task.task_id} failed: robot kept dropping it`,
              },
            ]);
            break;
          }
          // Stop and dock retry right away; other tasks wait out the retry delay
          if (task.type !== "stop" && task.type !== "return_to_dock") {
            task.not_before = Date.now() + config.task_retry_delay_ms;
          }
          console.log(`[TASK] ↺ ${task.task_id} requeued (retry ${task.retries})`);
          queue.requeue(task);
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

  // First task this robot may take; tasks pinned to other robots don't block it.
  // Stop and dock tasks don't need charge; everything else waits for charging.
  const charged = state.battery_pct > config.battery_low_pct + config.battery_assign_margin_pct;
  const now = Date.now();
  const task = queue.all().find((t) =>
    (!t.pinned_robot || t.pinned_robot === robotId) &&
    (!t.not_before || t.not_before <= now) &&
    (charged || t.type === "stop" || t.type === "return_to_dock")
  );
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
      : action === "charge" ? "return_to_dock" // "go to dock and charge"
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

  // Robot is (back) on its way to a task, e.g. after a dock detour: add its
  // route from here so nodes on the way back aren't reported as deviations
  const target = state.assigned_task?.target_node;
  if (
    msg.status === RobotStatus.EN_ROUTE &&
    state.status !== RobotStatus.EN_ROUTE &&
    target && msg.current_node !== null
  ) {
    const route = dijkstra(graph, msg.current_node, target);
    if (route) state.expected_path = [...new Set([...state.expected_path, ...route])];
  }

  const stopPending =
    state.assigned_task?.type === "stop" ||
    queue.all().some((t) => t.type === "stop" && t.pinned_robot === robotId);

  const { effects } = processTelemetry(state, msg, config, state.last_seen, stopPending);
  executeEffects(robotId, effects);

  // Robot is still working on a cancelled task (e.g. it was offline when
  // cancelled): tell it again, at most once per grace period
  if (
    msg.task_id && isCancelled(msg.task_id) &&
    state.last_seen - (cancelSentAt.get(robotId) ?? 0) > config.command_ack_timeout_ms
  ) {
    sendCancel(robotId, msg.task_id);
  }
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

  // Jog: manual driving from the dashboard, farm network only. Always
  // immediate, one robot, never queued. Not logged: it repeats while held.
  if (msg.command.command === "jog") {
    if (topic !== TOPICS.commands.local) {
      console.log(`[REMOTE] Jog rejected: only accepted from the farm network`);
      return;
    }
    if (!msg.robot_id || !robots.has(msg.robot_id)) {
      console.log(`[REMOTE] Jog for unknown robot: ${msg.robot_id}`);
      return;
    }
    const jog: RobotCommand = {
      command: "jog",
      direction: msg.command.direction,
      priority: TaskPriority.CRITICAL,
      source: CommandSource.LOCAL,
    };
    mqtt.publish(TOPICS.robot.command(msg.robot_id), jog);
    return;
  }

  // Accept immediate on the message or inside the command (dashboard rows)
  msg.immediate = msg.immediate ?? msg.command.immediate === true;
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
    if (targets.length === 0) console.log(`[REMOTE] Unknown robot: ${msg.robot_id}`);
    for (const [robotId] of targets) {
      mqtt.publish(TOPICS.robot.command(robotId), msg.command);
      console.log(`[REMOTE] → ${robotId}: ${msg.command.command}`);
    }
    return;
  }

  // Cancel: a queued task by id, or the robot's current task (also while
  // the robot is lost). The robot is told now and again if it reappears
  // still working on it.
  if (msg.command.command === "cancel") {
    const taskId = msg.command.task_id;
    if (!taskId && !msg.robot_id) {
      console.log(`[REMOTE] Cancel needs a robot_id or task_id`);
      return;
    }
    const finish = (task: FarmTask) => {
      task.status = TaskStatus.CANCELLED;
      task.completed_at = Date.now();
      task.error = `Cancelled by ${msg.issued_by}`;
      recordFinished(task);
      console.log(`[TASK] ${task.task_id} cancelled`);
    };

    const queued = taskId ? queue.remove(taskId) : null;
    if (queued) {
      finish(queued);
      return;
    }
    let found = false;
    for (const [robotId, state] of targets) {
      const task = state?.assigned_task;
      if (!state || !task || (taskId && task.task_id !== taskId)) continue;
      if (task.type === "stop") {
        console.log(`[REMOTE] ${task.task_id} is a stop; use resume instead of cancel`);
        found = true;
        continue;
      }
      state.assigned_task = null;
      state.expected_path = [];
      state.waypoints_hit = [];
      finish(task);
      sendCancel(robotId, task.task_id);
      found = true;
    }
    if (!found) console.log(`[REMOTE] Nothing to cancel`);
    return;
  }

  // Queued stop / return_to_dock: one pinned task per robot, carried
  // out once the robot finishes its current task
  if (msg.command.command === "stop" || msg.command.command === "return_to_dock") {
    if (targets.length === 0) {
      console.log(`[REMOTE] Unknown robot: ${msg.robot_id}`);
      return;
    }
    for (const [robotId] of targets) {
      const task = remoteTask(msg, msg.robot_id ? msg.id : `${msg.id}-${robotId}`);
      if (isKnownTask(task.task_id)) {
        console.log(`[REMOTE] Duplicate task ${task.task_id}, ignored`);
        continue;
      }
      task.pinned_robot = robotId;
      queue.push(task);
      console.log(`[QUEUE] +${task.task_id} (${task.type}) pinned to ${robotId}`);
      tryAssignTask(robotId);
    }
    return;
  }

  // --- Navigate commands -------------------------------------
  if (msg.command.command === "navigate" && msg.command.target_node) {
    const targetNode = graph.nodes.get(msg.command.target_node);
    if (!targetNode) {
      console.log(`[REMOTE] Unknown target node: ${msg.command.target_node}`);
      return;
    }
    // Robots only pass through elevators (docs/firmware-architecture.md)
    if (targetNode.type === "elevator") {
      console.log(`[REMOTE] ${msg.command.target_node} is an elevator, not a target`);
      return;
    }
    if (isKnownTask(msg.id)) {
      console.log(`[REMOTE] Duplicate task ${msg.id}, ignored`);
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
  // Restore tasks from the last run. Assigned tasks go back on their robot
  // as-is; its first telemetry reconciles them like any other.
  const saved = loadTasks(STATE_PATH);
  for (const task of saved.queue) queue.push(task);
  for (const task of saved.assigned) {
    if (task.assigned_robot) getOrCreateRobot(task.assigned_robot).assigned_task = task;
  }
  completedTasks.push(...saved.finished.slice(-config.completed_task_limit));
  publishStates();

  console.log(`[ORCH]   queue:     ${queue.length} tasks, ${saved.assigned.length} assigned (${STATE_PATH})`);

  // Subscribe to all robot telemetry
  mqtt.subscribe<unknown>(TOPICS.robot.telemetryAll, persisting(onTelemetry));

  // Subscribe to all robot events
  mqtt.subscribe<unknown>(TOPICS.robot.eventsAll, persisting(onEvent));

  // Subscribe to remote commands (from Supabase bridge)
  mqtt.subscribe<unknown>(TOPICS.commands.remote, persisting(onRemoteCommand));

  // Subscribe to local commands (from dashboard)
  mqtt.subscribe<unknown>(TOPICS.commands.local, persisting(onRemoteCommand));

  // Start watchdog timer
  setInterval(persisting(runWatchdog), config.watchdog_interval_ms);

  // --- Scheduler hook ----------------------------------------
  // When you add the plant scheduler module, import it here:
  //
  //   import { startScheduler } from "./scheduler.js";
  //   startScheduler(queue, robots, config);
  //
  // The scheduler pushes FarmTasks into the queue on plant-care
  // intervals. The orchestrator assigns them normally. Call
  // persist() after pushing so new tasks survive a restart.
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
