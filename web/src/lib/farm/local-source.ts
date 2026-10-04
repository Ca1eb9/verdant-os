// Live farm data on the farm network: MQTT over WebSocket straight to the
// Pi's broker (Mosquitto's port 9001 listener, docs/WIFI-SETUP.md).
//
// Robots come from their telemetry (the robot is the source of truth) plus
// the orchestrator's retained state (task, planned path, lost). Commands go
// to farm/commands/local, the path the orchestrator accepts jog on. The
// broker is only reachable on FarmNet, so no operator key is needed.
//
// The ingester saves every command to SQLite; the history comes from the
// Pi's Dashboard API, GET {apiUrl}/commands?robot_id=, which returns
// { commands: CommandRecord[] } newest first, like this app's /api/commands.
// With no apiUrl (the API isn't built yet) the history is empty.

import mqtt, { type MqttClient } from "mqtt";
import {
  CommandError,
  listCommandsFrom,
  type CommandRecord,
  type CommandRequest,
  type FarmConnection,
  type FarmDataSource,
} from "@/lib/farm/data-source";
import type { RobotTask, RobotView } from "@/lib/farm/robots";
import { TOPICS, extractIdFromTopic } from "@/lib/farm/topics";
import type {
  FarmTopology,
  RemoteCommand,
  RobotStateUpdate,
  RobotStatus,
  RobotTelemetry,
} from "@/lib/farm/types";

const RECONNECT_MS = 2_000;

const STATUSES: RobotStatus[] = [
  "idle", "en_route", "working", "returning_to_dock", "docking", "charging",
  "stopped", "lost", "error", "manual", "initializing",
];
const NODE_TYPES = ["checkpoint", "elevator", "dock", "water"];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStrOrNull = (v: unknown) => v === null || typeof v === "string";

function isTelemetry(v: unknown): v is RobotTelemetry {
  return isRecord(v) &&
    STATUSES.includes(v.status as RobotStatus) &&
    isStrOrNull(v.current_node) &&
    isNum(v.battery_pct) &&
    (v.heading === null || v.heading === 0 || v.heading === 1 || v.heading === 2 || v.heading === 3);
}

function isStateUpdate(v: unknown): v is RobotStateUpdate {
  if (!isRecord(v) || !STATUSES.includes(v.status as RobotStatus)) return false;
  if (!Array.isArray(v.expected_path) || !v.expected_path.every((n) => typeof n === "string")) return false;
  const t = v.task;
  return t === null || (isRecord(t) && typeof t.task_id === "string" && typeof t.type === "string" &&
    (t.target_node === undefined || typeof t.target_node === "string"));
}

function isTopology(v: unknown): v is FarmTopology {
  return isRecord(v) && Array.isArray(v.nodes) && Array.isArray(v.edges) &&
    v.nodes.every((n) => isRecord(n) && typeof n.id === "string" && isNum(n.x) && isNum(n.y) &&
      isNum(n.z) && NODE_TYPES.includes(n.type as string)) &&
    v.edges.every((e) => isRecord(e) && typeof e.from === "string" && typeof e.to === "string");
}

interface Entry {
  telemetry?: RobotTelemetry;
  /** Browser receive time of the last telemetry: there's no clock sync. 0 = none yet */
  seenAt: number;
  state?: RobotStateUpdate;
}

function toView(id: string, e: Entry): RobotView {
  const t = e.telemetry;
  const s = e.state;
  const task: RobotTask | null = s?.task
    ? { id: s.task.task_id, type: s.task.type, targetNode: s.task.target_node }
    : null;
  return {
    id,
    // The robot's own status, except "lost", which only the orchestrator knows
    status: s?.status === "lost" ? "lost" : t?.status ?? s?.status ?? "initializing",
    currentNode: t?.current_node ?? null,
    batteryPct: t?.battery_pct ?? 0,
    heading: t?.heading ?? undefined,
    lastSeen: e.seenAt,
    expectedPath: s?.expected_path.length ? s.expected_path : undefined,
    task,
  };
}

export function createLocalSource(url: string, apiUrl?: string): FarmDataSource {
  let client: MqttClient | null = null;
  const robots = new Map<string, Entry>();
  const listeners = new Set<(robots: RobotView[]) => void>();
  const topologyWaiters = new Set<(topology: FarmTopology | null) => void>();
  const connectionListeners = new Set<(connection: FarmConnection) => void>();
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  })();
  // Reasons are for the operator; the broker's address goes to the console
  const CONNECTING: FarmConnection = { state: "connecting", reason: "Connecting to the farm…" };
  let connection: FarmConnection = CONNECTING;
  const setConnection = (next: FarmConnection) => {
    connection = next;
    connectionListeners.forEach((listener) => listener(next));
  };
  const OFFLINE: FarmConnection = {
    state: "offline",
    reason: "Make sure this device is on the farm's Wi-Fi.",
  };
  let topology: FarmTopology | null = null;
  const warned = new Set<string>();

  const emit = () => {
    const list = [...robots].map(([id, e]) => toView(id, e));
    listeners.forEach((listener) => listener(list));
  };

  // One bad message per topic is worth a log line; a stream of them isn't
  const ignore = (topic: string) => {
    if (warned.has(topic)) return;
    warned.add(topic);
    console.warn(`[local-source] ignoring malformed message on ${topic}`);
  };

  const onMessage = (topic: string, payload: Uint8Array) => {
    let msg: unknown;
    try {
      msg = JSON.parse(new TextDecoder().decode(payload));
    } catch {
      ignore(topic);
      return;
    }
    if (topic === TOPICS.system.topology) {
      if (!isTopology(msg)) return ignore(topic);
      topology = msg;
      topologyWaiters.forEach((resolve) => resolve(msg));
      topologyWaiters.clear();
      updateConnection();
      return;
    }
    const id = extractIdFromTopic(topic);
    if (!id) return ignore(topic);
    const entry = robots.get(id) ?? { seenAt: 0 };
    if (topic.endsWith("/telemetry")) {
      if (!isTelemetry(msg)) return ignore(topic);
      entry.telemetry = msg;
      entry.seenAt = Date.now();
    } else {
      if (!isStateUpdate(msg)) return ignore(topic);
      entry.state = msg;
    }
    robots.set(id, entry);
    emit();
  };

  // Connected while anything needs it: the robot list, a pending layout or
  // the connection status
  const updateConnection = () => {
    const needed = listeners.size > 0 || topologyWaiters.size > 0 || connectionListeners.size > 0;
    if (needed && !client) {
      connection = CONNECTING;
      client = mqtt.connect(url, { reconnectPeriod: RECONNECT_MS, connectTimeout: RECONNECT_MS * 2 });
      client.on("message", onMessage);
      client.on("connect", () => setConnection({ state: "connected" }));
      // Each failed reconnect closes again: stays offline, no flicker to "connecting"
      client.on("close", () => {
        if (connection.state !== "offline") console.warn(`[local-source] lost the MQTT broker at ${host}`);
        setConnection(OFFLINE);
      });
      client.on("error", (err) => console.warn(`[local-source] ${err.message}`));
      client.subscribe([TOPICS.robot.telemetryAll, TOPICS.robot.stateAll, TOPICS.system.topology]);
    } else if (!needed && client) {
      client.end(true);
      client = null;
    }
  };

  return {
    mode: "local",

    // No timeout: the map shows the default layout until this resolves, so
    // a broker that comes up late still brings the real one.
    getTopology() {
      if (topology) return Promise.resolve(topology);
      return new Promise((resolve) => {
        topologyWaiters.add(resolve);
        updateConnection();
      });
    },

    subscribeRobots(onRobots) {
      listeners.add(onRobots);
      updateConnection();
      onRobots([...robots].map(([id, e]) => toView(id, e)));
      return () => {
        listeners.delete(onRobots);
        updateConnection();
      };
    },

    sendCommand(request: CommandRequest) {
      // Never queued for a reconnect: a stop or jog delivered late is worse than an error
      if (!client?.connected) {
        return Promise.reject(new CommandError("Not connected to the farm's MQTT broker.", 503));
      }
      const remote: RemoteCommand = {
        id: crypto.randomUUID(),
        robot_id: request.robot_id,
        command: { ...request.command, source: "local" },
        issued_by: "dashboard",
        issued_at: Date.now(),
      };
      return new Promise<CommandRecord>((resolve, reject) => {
        client!.publish(TOPICS.commands.local, JSON.stringify(remote), { qos: 0 }, (err) => {
          if (err) {
            reject(new CommandError(`Could not send the command: ${err.message}`, 502));
            return;
          }
          resolve({ ...remote, status: "sent" });
        });
      });
    },

    async listRecentCommands(robotId) {
      return apiUrl ? listCommandsFrom(`${apiUrl}/commands`, robotId) : [];
    },

    subscribeConnection(onChange) {
      connectionListeners.add(onChange);
      updateConnection();
      onChange(connection);
      return () => {
        connectionListeners.delete(onChange);
        updateConnection();
      };
    },
  };
}
