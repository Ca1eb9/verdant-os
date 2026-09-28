// ============================================================
// Robot simulator
//
// Pretends to be an ESP32 robot. Loads the farm topology,
// picks target nodes (water, checkpoints), pathfinds with
// Dijkstra, and publishes telemetry as it "moves" through
// RFID waypoints.
//
// Run:  npx tsx src/index.ts
// Flags:
//   AUTONOMOUS=false  — wait for orchestrator commands instead of self-assigning
//   ROBOT_ID=robot-1  — robot identifier
//   BROKER_URL=mqtt://localhost:1883
// ============================================================

import { readFileSync } from "fs";
import {
  type FarmTopology,
  type RobotTelemetry,
  type RobotCommand,
  type RobotEvent,
  RobotStatus,
  RobotEventType,
  Heading,
  TOPICS,
  buildGraph,
  dijkstra,
  computeHeading,
  createMqttClient,
  type TypedMqttClient,
} from "@farm/shared";

// --- Config --------------------------------------------------

const ROBOT_ID = process.env.ROBOT_ID ?? "robot-1";
const BROKER_URL = process.env.BROKER_URL ?? "mqtt://localhost:1883";
const TOPOLOGY_PATH = process.env.TOPOLOGY_PATH ?? "../../topology.json";
const AUTONOMOUS = process.env.AUTONOMOUS !== "false"; // default true
const MOVE_INTERVAL_MS = 2000;
const TELEMETRY_INTERVAL_MS = 1000;
const BATTERY_DRAIN_PER_MOVE = 1.5;
const BATTERY_CHARGE_RATE = 5;
const BATTERY_LOW_THRESHOLD = 20;
const BATTERY_CRITICAL_THRESHOLD = 15;

// --- Load topology -------------------------------------------

const topology: FarmTopology = JSON.parse(
  readFileSync(new URL(TOPOLOGY_PATH, import.meta.url), "utf-8")
);
const graph = buildGraph(topology);
const DOCK_NODE = topology.nodes.find((n) => n.type === "dock")!.id;

// --- Robot state ---------------------------------------------

const robot = {
  status: RobotStatus.IDLE,
  currentNodeId: "dock-1",
  heading: Heading.EAST,
  battery: 100,
  path: [] as string[],
  pathIndex: 0,
  targetNode: null as string | null,
  taskId: null as string | null,
  currentAction: "idle" as "water" | "grow" | "harvest" | "charge" | "idle",
  actionDurationMs: 0,
  actionStartedAt: 0,
  batteryLowPublished: false,
  batteryCriticalPublished: false,
  /** Task interrupted by a dock detour, resumed after charging */
  resumeTask: null as null | {
    taskId: string;
    targetNode: string;
    action: "water" | "grow" | "harvest" | "charge" | "idle";
    durationMs: number;
  },
  /** Status to return to on resume */
  pausedStatus: null as RobotStatus | null,
};

// --- MQTT client (set in main) -------------------------------

let mqtt: TypedMqttClient;

// --- Event publishing ----------------------------------------

function publishEvent(
  event: RobotEventType,
  details?: string
) {
  const msg: RobotEvent = {
    robot_id: ROBOT_ID,
    event,
    task_id: robot.taskId ?? undefined,
    node_id: robot.currentNodeId,
    details,
    timestamp: Date.now(),
  };
  mqtt.publish(TOPICS.robot.events(ROBOT_ID), msg);
  console.log(`[EVENT] ${event}${details ? ` — ${details}` : ""}`);
}

// --- Fake sensor readings ------------------------------------

function fakeTemperature(): number {
  return 22 + Math.random() * 6;
}

function fakeHumidity(): number {
  return 55 + Math.random() * 25;
}

function fakeLightLux(): number {
  const node = graph.nodes.get(robot.currentNodeId)!;
  const base = node.z * 200;
  return base + 300 + Math.random() * 100;
}

// --- Helpers -------------------------------------------------

const HEADING_LABEL = ["N", "E", "S", "W"];

function currentNode() {
  return graph.nodes.get(robot.currentNodeId)!;
}

function randomNodeOfType(type: string): string | null {
  const matches = topology.nodes.filter((n) => n.type === type);
  if (matches.length === 0) return null;
  return matches[Math.floor(Math.random() * matches.length)].id;
}

function buildTelemetry(): RobotTelemetry {
  const node = currentNode();
  return {
    robot_id: ROBOT_ID,
    status: robot.status,
    current_node: node.id,
    task_id: robot.taskId,
    battery_pct: Math.round(robot.battery * 10) / 10,
    heading: robot.heading,
    obstacle_cm: null,
    temperature_c: Math.round(fakeTemperature() * 10) / 10,
    humidity_pct: Math.round(fakeHumidity() * 10) / 10,
    light_lux: Math.round(fakeLightLux()),
    timestamp: Date.now(),
  };
}

function checkBatteryThresholds() {
  if (robot.battery < BATTERY_CRITICAL_THRESHOLD && !robot.batteryCriticalPublished) {
    robot.batteryCriticalPublished = true;
    publishEvent(RobotEventType.BATTERY_CRITICAL, `${robot.battery.toFixed(1)}%`);
  } else if (robot.battery < BATTERY_LOW_THRESHOLD && !robot.batteryLowPublished) {
    robot.batteryLowPublished = true;
    publishEvent(RobotEventType.BATTERY_LOW, `${robot.battery.toFixed(1)}%`);
  }
}

function resetBatteryFlags() {
  robot.batteryLowPublished = false;
  robot.batteryCriticalPublished = false;
}

function startNavigation(targetNode: string, path?: string[]): boolean {
  const route = path ?? dijkstra(graph, robot.currentNodeId, targetNode);
  if (!route || route.length < 1) return false;
  robot.path = route;
  robot.pathIndex = 0;
  robot.targetNode = targetNode;
  robot.status = RobotStatus.EN_ROUTE;
  return true;
}

/**
 * Head to the dock. A task in progress is kept (task_id stays set) and
 * resumed after charging. With no task, a dock task id is adopted.
 */
function startReturnToDock(dockTaskId?: string) {
  const path = dijkstra(graph, robot.currentNodeId, DOCK_NODE);
  if (!path) return;
  if (robot.taskId && robot.targetNode &&
      (robot.status === RobotStatus.EN_ROUTE || robot.status === RobotStatus.WORKING)) {
    robot.resumeTask = {
      taskId: robot.taskId,
      targetNode: robot.targetNode,
      action: robot.currentAction,
      durationMs: robot.actionDurationMs,
    };
  } else if (!robot.taskId) {
    robot.taskId = dockTaskId ?? null;
  }
  robot.path = path;
  robot.pathIndex = 0;
  robot.targetNode = DOCK_NODE;
  robot.currentAction = "charge";
  robot.status = RobotStatus.RETURNING_TO_DOCK;
}

// --- Simulation loop -----------------------------------------

async function main() {
  mqtt = await createMqttClient({
    serviceName: `simulator-${ROBOT_ID}`,
    brokerUrl: BROKER_URL,
  });

  console.log(`[SIM] Simulating ${ROBOT_ID}`);
  console.log(`[SIM]   start_node:  ${robot.currentNodeId}`);
  console.log(`[SIM]   battery:     ${robot.battery}%`);
  console.log(`[SIM]   autonomous:  ${AUTONOMOUS}`);
  console.log(`[SIM]   topology:    ${topology.nodes.length} nodes, ${topology.edges.length} edges`);

  // Listen for commands from orchestrator
  mqtt.subscribe<RobotCommand>(
    TOPICS.robot.command(ROBOT_ID),
    (cmd) => {
      console.log(`[CMD] received: ${cmd.command} -> ${cmd.target_node ?? "n/a"}`);

      if (cmd.command === "navigate" && cmd.target_node) {
        // Path is node ids; plan our own when it isn't included
        if (startNavigation(cmd.target_node, cmd.path)) {
          robot.taskId = cmd.task_id ?? null;
          robot.currentAction = cmd.action_at_target ?? "idle";
          robot.actionDurationMs = cmd.duration_ms ?? 0;
          robot.resumeTask = null;
          robot.pausedStatus = null;
        }
      }

      if (cmd.command === "return_to_dock") {
        startReturnToDock(cmd.task_id);
      }

      // Stop pauses in place and keeps the task; resume continues it
      if (cmd.command === "stop" && robot.status !== RobotStatus.STOPPED) {
        robot.pausedStatus = robot.status;
        robot.status = RobotStatus.STOPPED;
      }

      if (cmd.command === "resume" && robot.status === RobotStatus.STOPPED) {
        robot.status = robot.pausedStatus ?? RobotStatus.IDLE;
        robot.pausedStatus = null;
      }
    }
  );

  // Publish telemetry on interval
  setInterval(() => {
    mqtt.publish(TOPICS.robot.telemetry(ROBOT_ID), buildTelemetry());
  }, TELEMETRY_INTERVAL_MS);

  // Main simulation tick
  setInterval(() => {
    switch (robot.status) {
      case RobotStatus.IDLE:
        handleIdle();
        break;
      case RobotStatus.EN_ROUTE:
      case RobotStatus.RETURNING_TO_DOCK:
        handleMoving();
        break;
      case RobotStatus.WORKING:
        handleWorking();
        break;
      case RobotStatus.CHARGING:
        handleCharging();
        break;
      case RobotStatus.DOCKING:
        handleDocking();
        break;
    }
  }, MOVE_INTERVAL_MS);

  // Graceful shutdown
  process.on("SIGINT", async () => {
    console.log("[SIM] shutting down");
    await mqtt.disconnect();
    process.exit(0);
  });
}

// --- State handlers ------------------------------------------

function handleIdle() {
  // Battery-triggered return to dock (always active, even in non-autonomous mode)
  if (robot.battery < BATTERY_LOW_THRESHOLD) {
    console.log(`[NAV] battery low (${robot.battery.toFixed(1)}%), returning to dock`);
    startReturnToDock();
    return;
  }

  // In non-autonomous mode, wait for orchestrator commands
  if (!AUTONOMOUS) return;

  const roll = Math.random();

  if (roll < 0.4) {
    const target = randomNodeOfType("water");
    if (target) {
      const path = dijkstra(graph, robot.currentNodeId, target);
      if (path && path.length > 1) {
        robot.path = path;
        robot.pathIndex = 0;
        robot.targetNode = target;
        robot.taskId = `auto-${Date.now().toString(36)}`;
        robot.currentAction = "water";
        robot.actionDurationMs = 6000;
        robot.status = RobotStatus.EN_ROUTE;
        console.log(`[TASK] self-assigned: water at ${target} (${path.length} hops)`);
      }
    }
  } else {
    const target = randomNodeOfType("checkpoint");
    if (target) {
      const path = dijkstra(graph, robot.currentNodeId, target);
      if (path && path.length > 1) {
        robot.path = path;
        robot.pathIndex = 0;
        robot.targetNode = target;
        robot.taskId = `auto-${Date.now().toString(36)}`;
        robot.currentAction = "grow";
        robot.actionDurationMs = 10000;
        robot.status = RobotStatus.EN_ROUTE;
        console.log(`[TASK] self-assigned: grow at ${target} (${path.length} hops)`);
      }
    }
  }
}

function handleMoving() {
  if (robot.pathIndex >= robot.path.length - 1) {
    // Arrived at destination
    if (robot.status === RobotStatus.RETURNING_TO_DOCK) {
      robot.status = RobotStatus.DOCKING;
      publishEvent(RobotEventType.ARRIVED, `at dock`);
      console.log(`[NAV] arrived at dock, docking`);
    } else {
      publishEvent(RobotEventType.ARRIVED, `at ${robot.currentNodeId}`);
      robot.status = RobotStatus.WORKING;
      robot.actionStartedAt = Date.now();
      publishEvent(
        RobotEventType.TASK_STARTED,
        `${robot.currentAction} for ${robot.actionDurationMs / 1000}s`
      );
      console.log(
        `[NAV] arrived at ${robot.currentNodeId}, ` +
        `action=${robot.currentAction} duration=${robot.actionDurationMs / 1000}s`
      );
    }
    return;
  }

  // Move to next node
  robot.pathIndex++;
  const prevNodeId = robot.currentNodeId;
  robot.currentNodeId = robot.path[robot.pathIndex];

  const prevNode = graph.nodes.get(prevNodeId)!;
  const currNode = currentNode();
  robot.heading = computeHeading(prevNode, currNode) ?? robot.heading;
  robot.battery = Math.max(0, robot.battery - BATTERY_DRAIN_PER_MOVE);

  // Check battery thresholds after drain
  checkBatteryThresholds();

  console.log(
    `[MOV] ${prevNodeId} -> ${robot.currentNodeId} ` +
    `(${currNode.tag_id}) ` +
    `heading=${HEADING_LABEL[robot.heading]} ` +
    `battery=${robot.battery.toFixed(1)}%`
  );
}

function handleWorking() {
  const elapsed = Date.now() - robot.actionStartedAt;
  if (elapsed >= robot.actionDurationMs) {
    publishEvent(
      RobotEventType.TASK_COMPLETE,
      `${robot.currentAction} at ${robot.currentNodeId}`
    );
    console.log(`[DONE] ${robot.currentAction} complete at ${robot.currentNodeId}`);
    robot.status = RobotStatus.IDLE;
    robot.targetNode = null;
    robot.taskId = null;
    robot.currentAction = "idle";
    robot.actionDurationMs = 0;
    robot.actionStartedAt = 0;
  }
}

function handleDocking() {
  robot.status = RobotStatus.CHARGING;
  publishEvent(RobotEventType.DOCK_CONNECTED);
  // A dock task is done once connected; an interrupted task is kept
  if (robot.taskId && !robot.resumeTask) {
    publishEvent(RobotEventType.TASK_COMPLETE, `docked`);
    robot.taskId = null;
  }
  console.log(`[CHARGE] started`);
}

function handleCharging() {
  robot.battery = Math.min(100, robot.battery + BATTERY_CHARGE_RATE);
  if (robot.battery >= 95) {
    publishEvent(RobotEventType.CHARGE_COMPLETE, `${robot.battery.toFixed(1)}%`);
    resetBatteryFlags();
    console.log(`[CHARGE] complete (${robot.battery.toFixed(1)}%)`);
    robot.status = RobotStatus.IDLE;
    robot.currentAction = "idle";

    // Pick the interrupted task back up
    const resume = robot.resumeTask;
    robot.resumeTask = null;
    if (resume && startNavigation(resume.targetNode)) {
      robot.taskId = resume.taskId;
      robot.currentAction = resume.action;
      robot.actionDurationMs = resume.durationMs;
      console.log(`[TASK] resuming ${resume.taskId} at ${resume.targetNode}`);
    } else {
      robot.taskId = null;
    }
  }
}

// --- Start ---------------------------------------------------

main().catch((err) => {
  console.error("[FATAL] Simulator failed:", err);
  process.exit(1);
});