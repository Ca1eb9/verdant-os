// ============================================================
// Orchestrator — entry point
//
// Subscribes to robot telemetry and events, maintains state
// per robot, runs the state machine, and publishes commands.
//
// Run:  npx tsx src/index.ts
// ============================================================

import { readFileSync } from "fs";
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

// --- Config & topology ---------------------------------------

const CONFIG_PATH = process.env.CONFIG_PATH ?? "../../orchestrator-config.json";
const TOPOLOGY_PATH = process.env.TOPOLOGY_PATH ?? "../../topology.json";
const BROKER_URL = process.env.BROKER_URL ?? "mqtt://localhost:1883";

const config = loadConfig(CONFIG_PATH);
const topology: FarmTopology = JSON.parse(
  readFileSync(new URL(TOPOLOGY_PATH, import.meta.url), "utf-8")
);
const graph = buildGraph(topology);
const completedTasks: FarmTask[] = []

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
          completedTasks.push(state.assigned_task);
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
          completedTasks.push(state.assigned_task);
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
  if (state.battery_pct <= config.battery_low_pct) return; // needs charging first

  const task = queue.pop();
  if (!task) return;
  if (task.assigned_robot && task.assigned_robot !== robotId) {
    queue.requeue(task);  // not for this robot, put it back in front
    return;
  }

  // Compute path from robot's current position to target
  const path = dijkstra(graph, state.current_node, task.target_node);
  if (!path || path.length < 1) {
    console.log(
      `[ORCH] No path from ${state.current_node} to ${task.target_node}, skipping task`
    );
    return;
  }

  // Update state
  task.status = TaskStatus.ASSIGNED;
  task.assigned_robot = robotId;
  task.assigned_at = Date.now();
  state.assigned_task = task;
  state.expected_path = path;
  state.waypoints_hit = [];

  // Publish navigate command
  const command: RobotCommand = {
    command: "navigate",
    task_id: task.task_id,
    path: task.include_path ? path ?? [] : undefined,
    target_node: task.target_node,
    action_at_target: task.type === "custom" ? "idle" : task.type,
    duration_ms: task.duration_ms,
    priority: task.priority,
    source: task.source,
  };

  mqtt.publish(TOPICS.robot.command(robotId), command);
  console.log(
    `[ORCH] Assigned ${task.task_id} to ${robotId}: ` +
    `${task.type} at ${task.target_node} (${path.length} hops)`
  );
}

// --- MQTT handlers -------------------------------------------

function onTelemetry(msg: RobotTelemetry, topic: string) {
  const robotId = extractIdFromTopic(topic) ?? msg.robot_id;
  const state = getOrCreateRobot(robotId);

  const { effects } = processTelemetry(state, msg, config);
  executeEffects(robotId, effects);
}

function onEvent(event: RobotEvent, topic: string) {
  const robotId = extractIdFromTopic(topic) ?? event.robot_id;
  const state = getOrCreateRobot(robotId);

  console.log(
    `[EVENT] ${robotId}: ${event.event}` +
    (event.details ? ` — ${event.details}` : "")
  );

  const { effects } = processEvent(state, event, config);
  executeEffects(robotId, effects);
}

function onRemoteCommand(msg: RemoteCommand) {
  console.log(
    `[REMOTE] from ${msg.issued_by}: ${msg.command.command}` +
    (msg.robot_id ? ` -> ${msg.robot_id}` : "") +
    (msg.immediate ? " (immediate)" : "")
  );

  // Always skip the queue. Send to targeted robot or all robots.
  if (msg.command.command === "stop" ||
      msg.command.command === "return_to_dock" ||
      msg.command.command === "resume"
    ) {
    const targets = msg.robot_id
      ? [[msg.robot_id, robots.get(msg.robot_id)] as const].filter(([, s]) => s)
      : [...robots];

    for (const [robotId] of targets) {
      mqtt.publish(TOPICS.robot.command(robotId), msg.command);
      console.log(`[REMOTE] → ${robotId}: ${msg.command.command}`);
    }
    return;
  }

  // --- Navigate commands -------------------------------------
  if (msg.command.command === "navigate" && msg.command.target_node) {
    // Immediate: compute path and send directly, no queue
    if (msg.immediate && msg.robot_id) {
      const state = robots.get(msg.robot_id);
      if (!state) {
        console.log(`[REMOTE] Unknown robot: ${msg.robot_id}`);
        return;
      }

      const path = dijkstra(graph, state.current_node, msg.command.target_node);
      if (!path || path.length < 1) {
        console.log(`[REMOTE] No path from ${state.current_node} to ${msg.command.target_node}`);
        return;
      }

      mqtt.publish(TOPICS.robot.command(msg.robot_id), {
        ...msg.command,
        path: msg.include_path ? path : undefined,
        task_id: msg.id ?? randomUUID(),
      });
      console.log(
        `[REMOTE] → ${msg.robot_id}: immediate navigate to ` +
        `${msg.command.target_node} (${path.length} hops)`
      );
      return;
    }

    // Normal: create a task and queue it
    const task: FarmTask = {
      task_id: msg.id ?? randomUUID(),
      type: (msg.command.action_at_target as FarmTask["type"]) ?? "custom",
      target_node: msg.command.target_node,
      duration_ms: msg.command.duration_ms,
      priority: msg.command.priority ?? TaskPriority.NORMAL,
      source: CommandSource.REMOTE,
      created_at: Date.now(),
      status: TaskStatus.PENDING,
      assigned_robot: msg.robot_id,
      include_path: msg.include_path,
    };
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
          break;
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
  mqtt.subscribe<RobotTelemetry>(TOPICS.robot.telemetryAll, onTelemetry);

  // Subscribe to all robot events
  mqtt.subscribe<RobotEvent>(TOPICS.robot.eventsAll, onEvent);

  // Subscribe to remote commands (from Supabase bridge)
  mqtt.subscribe<RemoteCommand>(TOPICS.commands.remote, onRemoteCommand);

  // Subscribe to local commands (from dashboard)
  mqtt.subscribe<RemoteCommand>(TOPICS.commands.local, onRemoteCommand);

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
        `node=${s.current_node.padEnd(12)} ` +
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
