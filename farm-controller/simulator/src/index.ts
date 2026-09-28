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
const BATTERY_CUTOFF_THRESHOLD = 5;
/** Each jog drives for this long from receipt; a newer jog restarts it */
const JOG_PULSE_MS = 500;
const MANUAL_TICK_MS = 100;
/** Manual control ends by itself after this long without a jog */
const MANUAL_TIMEOUT_MS = 5000;

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
  lastCompletedTaskId: null as string | null,
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
  /** Set by stop, cleared by resume or a new navigate. Survives dock trips. */
  stopLatched: false,
  /** taskId was adopted from a return_to_dock command */
  dockTask: false,
  /** When stop paused the robot, to hold the action timer */
  pausedAt: 0,
  /** Status manual control interrupted */
  manualFrom: null as RobotStatus | null,
  jogDirection: null as "forward" | "backward" | null,
  /** Motors run until this time (deadman): each jog pushes it out */
  jogUntil: 0,
  /** Drive time accumulated towards the next node */
  jogDrivenMs: 0,
  /** Last jog received, for the manual timeout */
  lastJogAt: 0,
};

// --- MQTT client (set in main) -------------------------------

let mqtt: TypedMqttClient;

// --- Event publishing ----------------------------------------

function publishEvent(
  event: RobotEventType,
  details?: string,
  taskId: string | null = robot.taskId
) {
  const msg: RobotEvent = {
    robot_id: ROBOT_ID,
    event,
    task_id: taskId ?? undefined,
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
    last_completed_task_id: robot.lastCompletedTaskId,
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

const DOCK_TRIP = [RobotStatus.RETURNING_TO_DOCK, RobotStatus.DOCKING, RobotStatus.CHARGING];
const ON_TASK = [RobotStatus.EN_ROUTE, RobotStatus.WORKING];

/**
 * Head to the dock. A task in progress (or paused by stop) is kept
 * (task_id stays set) and resumed after charging. With no task, a dock
 * task id is adopted. Already on a dock trip: nothing to do.
 */
function startReturnToDock(dockTaskId?: string) {
  if (DOCK_TRIP.includes(robot.status)) return;
  const path = dijkstra(graph, robot.currentNodeId, DOCK_NODE);
  if (!path) return;
  const active =
    robot.status === RobotStatus.STOPPED ? robot.pausedStatus
    : robot.status === RobotStatus.MANUAL ? robot.manualFrom
    : robot.status;
  if (robot.taskId && !robot.dockTask && robot.targetNode && active && ON_TASK.includes(active)) {
    robot.resumeTask = {
      taskId: robot.taskId,
      targetNode: robot.targetNode,
      action: robot.currentAction,
      durationMs: robot.actionDurationMs,
    };
  } else if (!robot.taskId && dockTaskId) {
    robot.taskId = dockTaskId;
    robot.dockTask = true;
  }
  // a stop stays latched through the dock trip
  robot.pausedStatus = null;
  robot.manualFrom = null;
  robot.jogUntil = 0;
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
        const duplicate = cmd.task_id !== undefined &&
          (cmd.task_id === robot.taskId || cmd.task_id === robot.lastCompletedTaskId);
        // Path is node ids; plan our own when it isn't included
        if (duplicate) {
          console.log(`[CMD] duplicate navigate ${cmd.task_id}, ignored`);
        } else if (startNavigation(cmd.target_node, cmd.path)) {
          robot.taskId = cmd.task_id ?? null;
          robot.currentAction = cmd.action_at_target ?? "idle";
          robot.actionDurationMs = cmd.duration_ms ?? 0;
          robot.resumeTask = null;
          robot.pausedStatus = null;
          robot.stopLatched = false;
          robot.dockTask = false;
          robot.manualFrom = null;
          robot.jogUntil = 0;
        } else {
          publishEvent(RobotEventType.TASK_FAILED, `no path to ${cmd.target_node}`, cmd.task_id ?? null);
        }
      }

      if (cmd.command === "return_to_dock") {
        startReturnToDock(cmd.task_id);
      }

      // Stop pauses in place and keeps the task; resume continues it
      if (cmd.command === "stop" && robot.status !== RobotStatus.STOPPED) {
        robot.pausedStatus = robot.status;
        robot.status = RobotStatus.STOPPED;
        robot.stopLatched = true;
        robot.pausedAt = Date.now();
      }

      // Jog: take manual control and drive a short pulse (deadman)
      if (cmd.command === "jog" && cmd.direction) {
        const jogable = [RobotStatus.IDLE, RobotStatus.EN_ROUTE, RobotStatus.WORKING,
          RobotStatus.STOPPED, RobotStatus.ERROR, RobotStatus.MANUAL];
        if (jogable.includes(robot.status) && robot.battery > BATTERY_CUTOFF_THRESHOLD) {
          if (robot.status !== RobotStatus.MANUAL) {
            robot.manualFrom = robot.status;
            robot.status = RobotStatus.MANUAL;
            robot.path = [];
            console.log(`[MANUAL] taking manual control (was ${robot.manualFrom})`);
          }
          if (robot.jogDirection !== cmd.direction) robot.jogDrivenMs = 0;
          robot.jogDirection = cmd.direction;
          robot.jogUntil = Date.now() + JOG_PULSE_MS;
          robot.lastJogAt = Date.now();
        }
      }

      // Resume in manual hands control back: continue the task, or go idle
      if (cmd.command === "resume" && robot.status === RobotStatus.MANUAL) {
        exitManual();
      } else if (cmd.command === "resume" && robot.stopLatched) {
        robot.stopLatched = false;
        if (robot.status === RobotStatus.STOPPED) {
          const paused = robot.pausedStatus;
          robot.pausedStatus = null;
          // stopped at the dock after a detour: head back to the kept task
          if (!paused && robot.resumeTask) resumeKeptTask();
          // manual control may have moved it while stopped: re-plan unless still working at the target
          else if (paused && ON_TASK.includes(paused) && robot.targetNode &&
                   !(paused === RobotStatus.WORKING && robot.currentNodeId === robot.targetNode)) {
            startNavigation(robot.targetNode);
          }
          else robot.status = paused ?? RobotStatus.IDLE;
          // the action timer doesn't run while stopped
          if (paused === RobotStatus.WORKING) robot.actionStartedAt += Date.now() - robot.pausedAt;
        }
      }

      // Cancel drops the task only if it's ours. A dock detour (task paused
      // for charging) carries on to charge; a dock task stops heading there.
      if (cmd.command === "cancel" && cmd.task_id) {
        const dockTask = robot.dockTask;
        if (robot.resumeTask?.taskId === cmd.task_id) robot.resumeTask = null;
        if (robot.taskId === cmd.task_id) {
          robot.taskId = null;
          robot.dockTask = false;
          const onTask = (s: RobotStatus | null) =>
            s === RobotStatus.EN_ROUTE || s === RobotStatus.WORKING ||
            (dockTask && (s === RobotStatus.RETURNING_TO_DOCK || s === RobotStatus.DOCKING));
          if (onTask(robot.status) || onTask(robot.pausedStatus)) {
            if (robot.status !== RobotStatus.STOPPED) robot.status = RobotStatus.IDLE;
            else robot.pausedStatus = RobotStatus.IDLE;
            robot.path = [];
            robot.targetNode = null;
            robot.currentAction = "idle";
          }
          console.log(`[TASK] ${cmd.task_id} cancelled`);
        }
      }
    }
  );

  // Publish telemetry on interval
  setInterval(() => {
    mqtt.publish(TOPICS.robot.telemetry(ROBOT_ID), buildTelemetry());
  }, TELEMETRY_INTERVAL_MS);

  // Manual driving tick: move one node per MOVE_INTERVAL_MS of driving
  setInterval(handleManual, MANUAL_TICK_MS);

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
  // Survival override: forced return to dock (always active, even in non-autonomous mode)
  if (robot.battery < BATTERY_CRITICAL_THRESHOLD) {
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

  // Survival override: forced return to dock mid-task, task kept
  if (robot.battery < BATTERY_CRITICAL_THRESHOLD && robot.status === RobotStatus.EN_ROUTE) {
    console.log(`[NAV] battery critical (${robot.battery.toFixed(1)}%), forced return to dock`);
    startReturnToDock();
  }

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
    robot.lastCompletedTaskId = robot.taskId;
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
  if (robot.dockTask) {
    publishEvent(RobotEventType.TASK_COMPLETE, `docked`);
    robot.lastCompletedTaskId = robot.taskId;
    robot.taskId = null;
    robot.dockTask = false;
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

    // Still stopped: wait for resume, keeping any interrupted task
    if (robot.stopLatched) {
      robot.status = RobotStatus.STOPPED;
      robot.pausedStatus = null;
      return;
    }
    resumeKeptTask();
  }
}

function handleManual() {
  if (robot.status !== RobotStatus.MANUAL) return;
  if (Date.now() - robot.lastJogAt > MANUAL_TIMEOUT_MS) {
    exitManual(true);
    return;
  }
  if (!robot.jogDirection || Date.now() >= robot.jogUntil) return;
  robot.jogDrivenMs += MANUAL_TICK_MS;
  if (robot.jogDrivenMs < MOVE_INTERVAL_MS) return;
  robot.jogDrivenMs = 0;

  // forward follows the heading; backward reverses without turning
  const want = robot.jogDirection === "forward" ? robot.heading : ((robot.heading + 2) % 4) as Heading;
  const here = currentNode();
  const next = (graph.adjacency.get(here.id) ?? [])
    .map((n) => graph.nodes.get(n.neighborId)!)
    .find((n) => computeHeading(here, n) === want);
  if (!next) return; // end of the track
  robot.currentNodeId = next.id;
  robot.battery = Math.max(0, robot.battery - BATTERY_DRAIN_PER_MOVE);
  checkBatteryThresholds();
  console.log(`[JOG] ${robot.jogDirection} ${here.id} -> ${next.id} battery=${robot.battery.toFixed(1)}%`);
}

/**
 * Leave manual control: re-plan to the kept task from here, or go idle.
 * On a timeout a robot that was stopped goes back to stopped; resume
 * releases the stop too.
 */
function exitManual(timedOut = false) {
  console.log(`[MANUAL] releasing control${timedOut ? " (timeout)" : ""}`);
  const from = robot.manualFrom;
  robot.manualFrom = null;
  robot.jogUntil = 0;
  robot.jogDirection = null;
  if (timedOut && from === RobotStatus.STOPPED) {
    robot.status = RobotStatus.STOPPED; // pausedStatus and the latch are kept
    robot.path = [];
    return;
  }
  robot.stopLatched = false;
  robot.pausedStatus = null;
  if (robot.taskId && robot.targetNode && startNavigation(robot.targetNode)) {
    console.log(`[TASK] continuing ${robot.taskId} at ${robot.targetNode}`);
  } else {
    // idle never holds a task
    if (robot.taskId) publishEvent(RobotEventType.TASK_FAILED, `can't continue after manual control`);
    robot.taskId = null;
    robot.status = RobotStatus.IDLE;
    robot.path = [];
  }
}

/** Pick an interrupted task back up after charging, or go idle */
function resumeKeptTask() {
  const resume = robot.resumeTask;
  robot.resumeTask = null;
  if (resume && startNavigation(resume.targetNode)) {
    robot.taskId = resume.taskId;
    robot.currentAction = resume.action;
    robot.actionDurationMs = resume.durationMs;
    console.log(`[TASK] resuming ${resume.taskId} at ${resume.targetNode}`);
  } else {
    robot.status = RobotStatus.IDLE;
    robot.taskId = null;
  }
}

// --- Start ---------------------------------------------------

main().catch((err) => {
  console.error("[FATAL] Simulator failed:", err);
  process.exit(1);
});