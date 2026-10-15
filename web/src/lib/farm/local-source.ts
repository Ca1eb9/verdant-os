// Live farm data on the farm network: MQTT over WebSocket straight to the
// Pi's broker (Mosquitto's port 9001 listener, docs/WIFI-SETUP.md).
//
// Robots come from their telemetry (the robot is the source of truth) plus
// the orchestrator's retained state (task, planned path, lost). Commands go
// to farm/commands/local, the path the orchestrator accepts jog on. The
// broker is only reachable on FarmNet, so no operator key is needed.
//
// The command history is kept in memory from farm/commands/+, so commands
// from every browser and the remote bridge show up live. What was sent
// before this page loaded comes once per robot from the Pi's Dashboard API,
// GET {apiUrl}/commands?robot_id=, which returns { commands: CommandRecord[] }
// newest first, like this app's /api/commands. With no apiUrl the history
// starts empty and fills as commands are sent.
//
// Alerts are kept in memory the same way, from farm/alerts (not retained).
// The earlier ones come once from GET {apiUrl}/alerts and go behind them, so
// an alert still open after a reload is listed with its resolution.
//
// Shelf readings come from farm/shelf/+/sensors (not retained, one per shelf
// every few seconds), so the first arrives within a report interval. Every
// reading is also kept, for the History page's charts, while the connection
// pill keeps the source connected on any page. In front of them go the stored
// ones, loaded once from GET {apiUrl}/shelves as 5-minute means.

import mqtt, { type MqttClient } from "mqtt";
import {
  CommandError,
  listCommandsFrom,
  type CommandRecord,
  type CommandRequest,
  type FarmConnection,
  type FarmDataSource,
  type ShelfReading,
} from "@/lib/farm/data-source";
import type { RobotTask, RobotView } from "@/lib/farm/robots";
import { TOPICS, extractIdFromTopic } from "@/lib/farm/topics";
import type {
  AlertSeverity,
  FarmAlert,
  FarmTopology,
  RemoteCommand,
  RobotStateUpdate,
  RobotStatus,
  RobotTelemetry,
  ShelfSensorData,
} from "@/lib/farm/types";

const RECONNECT_MS = 2_000;
/** Commands listed per robot: the Dashboard API returns the same */
const RECENT_COMMANDS = 10;
/** Commands kept in memory across all robots */
const KEPT_COMMANDS = 200;
/**
 * Alerts kept in memory, and loaded from the Dashboard API (its most): enough
 * that an open problem's alert is there even when its resolution is far newer
 */
const KEPT_ALERTS = 500;
/** Shelf readings kept for history: a day of one shelf reporting every 5 s */
const KEPT_SHELF_READINGS = 17_280;
/** Stored shelf history loaded once: the History page's longest range */
const STORED_HISTORY_MS = 7 * 24 * 60 * 60_000;
/** ...as one mean per shelf per bucket: a 24 h chart's points are this size too */
const STORED_HISTORY_BUCKET_MS = 5 * 60_000;
/** The Dashboard API's most: a full week for up to four shelves; with more, the oldest days drop */
const STORED_HISTORY_LIMIT = 10_000;

const STATUSES: RobotStatus[] = [
  "idle", "en_route", "working", "returning_to_dock", "docking", "charging",
  "stopped", "lost", "error", "manual", "initializing",
];
const NODE_TYPES = ["checkpoint", "elevator", "dock", "water"];
const COMMANDS = ["navigate", "return_to_dock", "stop", "resume", "cancel", "jog", "connect_controller"];
const SEVERITIES: AlertSeverity[] = ["info", "warning", "critical"];
const ALERT_SOURCES = ["robot", "elevator", "shelf", "system"];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStrOrNull = (v: unknown) => v === null || typeof v === "string";
const isOptStr = (v: unknown) => v === undefined || typeof v === "string";
const isNumOrNull = (v: unknown) => v === null || isNum(v);

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

// Only the fields the history shows; the orchestrator validates the rest
function isCommand(v: unknown): v is RemoteCommand {
  if (!isRecord(v) || !isRecord(v.command)) return false;
  const c = v.command;
  return typeof v.id === "string" && typeof v.robot_id === "string" && typeof v.issued_by === "string" &&
    isNum(v.issued_at) && COMMANDS.includes(c.command as string) && isOptStr(c.target_node) &&
    isOptStr(c.task_id) && (c.immediate === undefined || typeof c.immediate === "boolean");
}

function isAlert(v: unknown): v is FarmAlert {
  return isRecord(v) && typeof v.alert_id === "string" && v.alert_id.length > 0 &&
    SEVERITIES.includes(v.severity as AlertSeverity) && typeof v.source === "string" &&
    ALERT_SOURCES.includes(v.source_type as string) && typeof v.message === "string" &&
    typeof v.metric === "string" && isNum(v.value) && isNum(v.threshold) && isNum(v.timestamp) &&
    (v.resolves === null || (typeof v.resolves === "string" && v.resolves.length > 0));
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${response.status} from ${url}`);
  return response.json();
}

function isShelfData(v: unknown): v is ShelfSensorData {
  return isRecord(v) && typeof v.shelf_id === "string" && v.shelf_id.length > 0 &&
    Number.isInteger(v.level) && isNumOrNull(v.temperature_c) && isNumOrNull(v.humidity_pct) &&
    isNumOrNull(v.light_lux) && isNumOrNull(v.water_temp_c) &&
    (v.water_level_ok === null || typeof v.water_level_ok === "boolean") && isNumOrNull(v.ph) &&
    isNum(v.timestamp);
}

interface Entry {
  telemetry?: RobotTelemetry;
  /** Browser receive time of the last telemetry: there's no clock sync. 0 = none yet */
  seenAt: number;
  state?: RobotStateUpdate;
}

/** Optional readings are dropped on their own when malformed, keeping the rest of the telemetry */
const optNum = (v: unknown) => (isNum(v) ? v : undefined);

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
    temperatureC: optNum(t?.temperature_c),
    humidityPct: optNum(t?.humidity_pct),
    controllerConnected: typeof t?.controller_connected === "boolean" ? t.controller_connected : undefined,
  };
}

export function createLocalSource(url: string, apiUrl?: string): FarmDataSource {
  let client: MqttClient | null = null;
  const robots = new Map<string, Entry>();
  const listeners = new Set<(robots: RobotView[]) => void>();
  const topologyWaiters = new Set<(topology: FarmTopology | null) => void>();
  const connectionListeners = new Set<(connection: FarmConnection) => void>();
  const alertListeners = new Set<(alerts: FarmAlert[]) => void>();
  const shelfListeners = new Set<(shelves: ShelfReading[]) => void>();
  const historyListeners = new Set<(readings: ShelfReading[]) => void>();
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
  /** Newest received first: issued_at comes from other clocks */
  let commands: CommandRecord[] = [];
  /** Robots whose earlier commands were loaded from the Dashboard API ("" = all) */
  const loadedHistory = new Set<string>();
  /** Newest received first: timestamp comes from other clocks */
  let alerts: FarmAlert[] = [];
  /** Latest reading per shelf_id */
  const shelves = new Map<string, ShelfReading>();
  /** Every shelf reading since the page opened, oldest first */
  let shelfHistory: ShelfReading[] = [];
  /** Stored readings from before those, oldest first */
  let storedHistory: ShelfReading[] = [];
  /** Loaded from the Dashboard API (or loading): each once per page */
  const loaded = new Set<"alerts" | "shelves">();
  /** Bumped by farm/alerts/clear: alerts loaded from before it were deleted */
  let alertsCleared = 0;

  const recordCommand = (record: CommandRecord) => {
    if (commands.some((c) => c.id === record.id)) return;
    commands = [record, ...commands].slice(0, KEPT_COMMANDS);
  };

  const emit = () => {
    const list = [...robots].map(([id, e]) => toView(id, e));
    listeners.forEach((listener) => listener(list));
  };

  const warnOnce = (key: string, message: string) => {
    if (warned.has(key)) return;
    warned.add(key);
    console.warn(`[local-source] ${message}`);
  };
  // One bad message per topic is worth a log line; a stream of them isn't
  const ignore = (topic: string) => warnOnce(topic, `ignoring malformed message on ${topic}`);

  const emitAlerts = () => alertListeners.forEach((listener) => listener(alerts));
  const emitHistory = () => {
    const readings = [...storedHistory, ...shelfHistory];
    historyListeners.forEach((listener) => listener(readings));
  };

  // Once per page, on first use; a failure is retried on the next subscribe
  const loadOnce = async (what: "alerts" | "shelves", load: (api: string) => Promise<void>) => {
    if (!apiUrl || loaded.has(what)) return;
    loaded.add(what);
    try {
      await load(apiUrl);
    } catch (err) {
      loaded.delete(what);
      warnOnce(`stored ${what}`, `no stored ${what} from the Dashboard API: ${err instanceof Error ? err.message : err}`);
    }
  };

  const loadStoredAlerts = () =>
    loadOnce("alerts", async (api) => {
      const cleared = alertsCleared;
      const body = await getJson(`${api}/alerts?limit=${KEPT_ALERTS}`);
      if (!isRecord(body) || !Array.isArray(body.alerts)) throw new Error("unexpected response");
      if (cleared !== alertsCleared) return;
      // older than anything heard live, so they go after it
      const ids = new Set(alerts.map((a) => a.alert_id));
      const earlier = body.alerts.filter((a): a is FarmAlert => isAlert(a) && !ids.has(a.alert_id));
      alerts = [...alerts, ...earlier].slice(0, KEPT_ALERTS);
      emitAlerts();
    });

  const loadStoredHistory = () =>
    loadOnce("shelves", async (api) => {
      // `to` left to the Pi: its clock, like received_at
      const params = new URLSearchParams({
        from: String(Date.now() - STORED_HISTORY_MS),
        bucket_ms: String(STORED_HISTORY_BUCKET_MS),
        limit: String(STORED_HISTORY_LIMIT),
      });
      const body = await getJson(`${api}/shelves?${params}`);
      if (!isRecord(body) || !Array.isArray(body.readings)) throw new Error("unexpected response");
      // received_at is the Pi's clock and live readings this browser's (no
      // clock sync): the stored ones stop where the live ones start
      const liveFrom = shelfHistory[0]?.receivedAt ?? Infinity;
      storedHistory = body.readings.flatMap((row: unknown) => {
        if (!isShelfData(row)) return [];
        const { received_at: receivedAt, ...data } = row as ShelfSensorData & { received_at?: unknown };
        return isNum(receivedAt) && receivedAt < liveFrom ? [{ data, receivedAt }] : [];
      });
      emitHistory();
    });

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
    if (topic === TOPICS.alertsClear) {
      if (!isRecord(msg) || !isNum(msg.timestamp)) return ignore(topic);
      alerts = [];
      alertsCleared++;
      emitAlerts();
      return;
    }
    if (topic === TOPICS.alerts) {
      if (!isAlert(msg)) return ignore(topic);
      if (alerts.some((a) => a.alert_id === msg.alert_id)) return;
      alerts = [msg, ...alerts].slice(0, KEPT_ALERTS);
      emitAlerts();
      return;
    }
    if (topic.endsWith("/sensors")) {
      if (!isShelfData(msg)) return ignore(topic);
      const reading = { data: msg, receivedAt: Date.now() };
      shelves.set(msg.shelf_id, reading);
      const list = [...shelves.values()];
      shelfListeners.forEach((listener) => listener(list));
      shelfHistory = [...shelfHistory, reading].slice(-KEPT_SHELF_READINGS);
      emitHistory();
      return;
    }
    if (topic === TOPICS.commands.local || topic === TOPICS.commands.remote) {
      if (!isCommand(msg)) return ignore(topic);
      // jogs repeat while held; they'd push everything else out
      if (msg.command.command !== "jog") recordCommand({ ...msg, status: "sent" });
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

  // Connected while anything needs it: the robot list, a pending layout, the
  // connection status, the alerts, the shelf readings or their history
  const updateConnection = () => {
    const needed = listeners.size > 0 || topologyWaiters.size > 0 || connectionListeners.size > 0 ||
      alertListeners.size > 0 || shelfListeners.size > 0 || historyListeners.size > 0;
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
      client.subscribe([
        TOPICS.robot.telemetryAll, TOPICS.robot.stateAll, TOPICS.system.topology, TOPICS.commands.all, TOPICS.alerts,
        TOPICS.alertsClear, TOPICS.shelf.sensorsAll,
      ]);
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
          const record: CommandRecord = { ...remote, status: "sent" };
          // listed now; the broker's echo of it is a duplicate
          if (remote.command.command !== "jog") recordCommand(record);
          resolve(record);
        });
      });
    },

    async listRecentCommands(robotId) {
      const key = robotId ?? "";
      if (apiUrl && !loadedHistory.has(key)) {
        try {
          // older than anything heard live, so they go after it
          const loaded: unknown[] = await listCommandsFrom(`${apiUrl}/commands`, robotId);
          loaded.filter(isCommand).forEach((record) => {
            if (commands.some((c) => c.id === record.id)) return;
            commands = [...commands, { ...record, status: "sent" as const }].slice(0, KEPT_COMMANDS);
          });
          loadedHistory.add(key);
        } catch (err) {
          // retried on the next refresh; the live history still fills meanwhile
          warnOnce("history", `no command history from the Dashboard API: ${err instanceof Error ? err.message : err}`);
        }
      }
      return commands.filter((c) => !robotId || c.robot_id === robotId).slice(0, RECENT_COMMANDS);
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

    subscribeAlerts(onAlerts) {
      alertListeners.add(onAlerts);
      updateConnection();
      onAlerts(alerts);
      void loadStoredAlerts();
      return () => {
        alertListeners.delete(onAlerts);
        updateConnection();
      };
    },

    subscribeShelves(onShelves) {
      shelfListeners.add(onShelves);
      updateConnection();
      onShelves([...shelves.values()]);
      return () => {
        shelfListeners.delete(onShelves);
        updateConnection();
      };
    },

    subscribeShelfHistory(onHistory) {
      historyListeners.add(onHistory);
      updateConnection();
      onHistory([...storedHistory, ...shelfHistory]);
      void loadStoredHistory();
      return () => {
        historyListeners.delete(onHistory);
        updateConnection();
      };
    },
  };
}
