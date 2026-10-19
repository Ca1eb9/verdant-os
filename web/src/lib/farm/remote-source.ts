// Live farm data from anywhere: Supabase, which each farm's Supabase bridge
// keeps in sync with its MQTT bus (farm-controller/supabase-bridge, the
// tables in web/supabase/*.sql).
//
// Everything is loaded once from its table, then followed through Realtime
// on the private channel farm-data, filtered to this farm (robot ids repeat
// across farms). Realtime misses what changes while it's away, so every
// (re)join loads again; changes that arrive during a load are applied after
// it. The farm is online while its bridge's key (the farm id) is in the
// farm-status channel's presence state; only a bridge can put it there.
//
// The browser has only the publishable key: it reads and listens, never
// writes. Commands go through this app's /api/commands route into
// remote_commands, which the bridge relays to the farm.
//
// There's no clock sync: what arrives live is stamped with this browser's
// receive time, what's loaded with Supabase's created_at.

import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";
import {
  CommandError,
  listCommandsFrom,
  readJson,
  type CommandRecord,
  type FarmConnection,
  type FarmDataSource,
  type ShelfReading,
} from "@/lib/farm/data-source";
import { toRobotView, type RobotEntry, type RobotView } from "@/lib/farm/robots";
import type {
  FarmAlert,
  FarmTopology,
  RobotStateUpdate,
  RobotTelemetry,
  ThresholdLimits,
} from "@/lib/farm/types";
import {
  isAlert, isRecord, isShelfValues, isStateUpdate, isTelemetry, isThresholdLimits, isTopology,
} from "@/lib/farm/validate";
import { FARM_ID_PATTERN } from "@/lib/farms";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();

/** Wait before loading again after a failed load */
const RETRY_MS = 5_000;
/** Alerts loaded and kept: as many as the local source, for the same reason (an open problem's alert can be far older than its resolution) */
const KEPT_ALERTS = 500;
/** Newest sensor_events rows read for each shelf's latest: a few minutes of a farm's shelves; one silent longer has no latest */
const RECENT_SHELF_ROWS = 100;
/** Shelf readings kept for history, as in the local source */
const KEPT_SHELF_READINGS = 17_280;
/** Stored shelf history loaded once: the History page's longest range... */
const STORED_HISTORY_MS = 7 * 24 * 60 * 60_000;
/** ...as one mean per shelf per bucket, like the local source's */
const STORED_HISTORY_BUCKET_MS = 5 * 60_000;
/** Buckets loaded at most: a full week for up to four shelves, as on FarmNet */
const STORED_HISTORY_LIMIT = 10_000;
/** Supabase returns at most this many rows per request (the project's default max rows) */
const PAGE_ROWS = 1_000;

const TELEMETRY_COLUMNS =
  "id,robot_id,status,current_node,task_id,last_completed_task_id,battery_pct,heading,obstacle_cm," +
  "temperature_c,humidity_pct,light_lux,timestamp,created_at";
const STATE_COLUMNS = "robot_id,status,task,expected_path,timestamp";
const ALERT_COLUMNS = "alert_id,severity,source,source_type,message,metric,value,threshold,timestamp,resolves";
const SENSOR_COLUMNS = "device,ts,air_temp_c,humidity_pct,water_temp_c,water_level_ok,ph,light_lux,created_at";

// Reasons are for the operator: no service names, hosts or settings (those go to the console)
const CONNECTING: FarmConnection = { state: "connecting", reason: "Connecting to the farm…" };
const UNREACHABLE: FarmConnection = { state: "offline", reason: "Can't reach the cloud service." };
const FARM_OFFLINE: FarmConnection = { state: "offline", reason: "The farm isn't online right now." };
const NOT_SET_UP: FarmConnection = { state: "offline", reason: "Remote access isn't set up." };

type Row = Record<string, unknown>;

interface Change {
  table: string;
  type: "INSERT" | "UPDATE" | "DELETE";
  row: Row;
  old: Row;
  /** Browser receive time */
  at: number;
}

interface Robot extends RobotEntry {
  /** robot_telemetry.id of `telemetry`, so an older row never replaces a newer one; 0 = none */
  telemetryId: number;
}

/** A number, or one Postgres sent as a string (numeric, bigint) */
function toNum(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** Null stays null; anything else must be a number (undefined when it isn't, which the checks refuse) */
const toNumOrNull = (v: unknown) => (v === null ? null : toNum(v));

/** Unix ms from a timestamptz as PostgREST or Realtime sends it, or null */
function toTime(v: unknown): number | null {
  if (typeof v !== "string") return null;
  // Realtime can send "2026-10-19 22:25:32.216713+00": ISO wants the T, ms and a full offset
  const iso = v.replace(" ", "T").replace(/(\.\d{3})\d+/, "$1").replace(/([+-]\d{2})$/, "$1:00");
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function telemetryFrom(row: Row): RobotTelemetry | null {
  const t = {
    robot_id: row.robot_id,
    status: row.status,
    current_node: row.current_node,
    task_id: row.task_id,
    last_completed_task_id: row.last_completed_task_id,
    battery_pct: toNum(row.battery_pct),
    heading: row.heading === null ? null : toNum(row.heading),
    obstacle_cm: toNumOrNull(row.obstacle_cm),
    // optional readings: a null column is a reading the robot didn't send
    temperature_c: toNum(row.temperature_c),
    humidity_pct: toNum(row.humidity_pct),
    light_lux: toNum(row.light_lux),
    timestamp: toNum(row.timestamp),
  };
  return isTelemetry(t) && typeof t.robot_id === "string" && t.robot_id.length > 0 ? t : null;
}

function stateFrom(row: Row): RobotStateUpdate | null {
  const s = {
    robot_id: row.robot_id,
    status: row.status,
    task: row.task,
    expected_path: row.expected_path,
    timestamp: toNum(row.timestamp),
  };
  return isStateUpdate(s) && typeof s.robot_id === "string" && s.robot_id.length > 0 ? s : null;
}

function alertFrom(row: Row): FarmAlert | null {
  const a = {
    alert_id: row.alert_id,
    severity: row.severity,
    source: row.source,
    source_type: row.source_type,
    message: row.message,
    metric: row.metric,
    value: toNum(row.value),
    threshold: toNum(row.threshold),
    timestamp: toNum(row.timestamp),
    resolves: row.resolves,
  };
  return isAlert(a) ? a : null;
}

/** A sensor_events row as a shelf reading; its time is the reading's on the Pi (ts) */
function shelfFrom(row: Row): ShelfReading["data"] | null {
  const data = {
    shelf_id: row.device,
    temperature_c: toNumOrNull(row.air_temp_c),
    humidity_pct: toNumOrNull(row.humidity_pct),
    light_lux: toNumOrNull(row.light_lux),
    water_temp_c: toNumOrNull(row.water_temp_c),
    water_level_ok: row.water_level_ok,
    ph: toNumOrNull(row.ph),
    timestamp: toTime(row.ts) ?? toTime(row.created_at),
  };
  return isShelfValues(data) ? data : null;
}

/** A malformed limit is dropped on its own; the rest still draw */
function thresholdsFrom(v: unknown): ThresholdLimits[] | null {
  return Array.isArray(v) ? v.filter(isThresholdLimits) : null;
}

/** The rows of a Supabase request, or throws its error */
async function rowsOf(request: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<Row[]> {
  const { data, error } = await request;
  if (error) throw new Error(error.message);
  return Array.isArray(data) ? data.filter(isRecord) : [];
}

export function createRemoteSource(farmId: string): FarmDataSource {
  const configured = Boolean(SUPABASE_URL && SUPABASE_KEY && FARM_ID_PATTERN.test(farmId));
  if (!configured && typeof window !== "undefined") {
    console.warn(
      FARM_ID_PATTERN.test(farmId)
        ? "[remote-source] NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY isn't set (docs/SUPABASE-SETUP.md)"
        : `[remote-source] invalid farm id "${farmId}"`,
    );
  }
  const filter = `farm_id=eq.${farmId}`;

  let db: SupabaseClient | null = null;
  /** Bumped on every open and close: a load from before it is discarded */
  let generation = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** Changes received while a load runs, applied after it */
  let buffered: Change[] | null = null;
  let loading = false;
  let loadAgain = false;

  const robotListeners = new Set<(robots: RobotView[]) => void>();
  const topologyWaiters = new Set<(topology: FarmTopology | null) => void>();
  const connectionListeners = new Set<(connection: FarmConnection) => void>();
  const alertListeners = new Set<(alerts: FarmAlert[] | null) => void>();
  const shelfListeners = new Set<(shelves: ShelfReading[]) => void>();
  const historyListeners = new Set<(readings: ShelfReading[]) => void>();
  const thresholdListeners = new Set<(thresholds: ThresholdLimits[] | null) => void>();

  let connection: FarmConnection = configured ? CONNECTING : NOT_SET_UP;
  const robots = new Map<string, Robot>();
  /** Undefined until loaded; null when the farm has none (the default layout) */
  let topology: FarmTopology | null | undefined;
  /** Null until the first load, or a live alert, so the pages don't say "no alerts" too early */
  let alerts: FarmAlert[] | null = null;
  /** Null until known, or when the farm has none (its alert engine never ran) */
  let thresholds: ThresholdLimits[] | null = null;
  /** Latest reading per shelf */
  const shelves = new Map<string, ShelfReading>();
  /** Every shelf reading received live, oldest first */
  let shelfHistory: ShelfReading[] = [];
  /** Stored ones from before those, oldest first */
  let storedHistory: ShelfReading[] = [];
  /** Stored history loaded, or loading: once per source; a failure is retried on the next subscribe or load */
  let historyLoaded = false;

  const warned = new Set<string>();
  const warnOnce = (key: string, message: string) => {
    if (warned.has(key)) return;
    warned.add(key);
    console.warn(`[remote-source] ${message}`);
  };
  // One bad row per table is worth a log line; a stream of them isn't
  const ignore = (table: string) => warnOnce(`row ${table}`, `ignoring a malformed ${table} row`);

  const setConnection = (next: FarmConnection) => {
    connection = next;
    connectionListeners.forEach((listener) => listener(next));
  };
  const robotList = () => [...robots].map(([id, robot]) => toRobotView(id, robot));
  const emitRobots = () => {
    const list = robotList();
    robotListeners.forEach((listener) => listener(list));
  };
  const emitAlerts = () => alertListeners.forEach((listener) => listener(alerts));
  const emitShelves = () => {
    const list = [...shelves.values()];
    shelfListeners.forEach((listener) => listener(list));
  };
  const emitHistory = () => {
    const readings = [...storedHistory, ...shelfHistory];
    historyListeners.forEach((listener) => listener(readings));
  };
  const emitThresholds = () => thresholdListeners.forEach((listener) => listener(thresholds));
  const resolveTopology = () => {
    topologyWaiters.forEach((resolve) => resolve(topology ?? null));
    topologyWaiters.clear();
  };
  const emitAll = () => {
    emitRobots();
    emitAlerts();
    emitShelves();
    emitHistory();
    emitThresholds();
  };

  const robotEntry = (id: string) => {
    let robot = robots.get(id);
    if (!robot) {
      robot = { seenAt: 0, telemetryId: 0 };
      robots.set(id, robot);
    }
    return robot;
  };

  /** Keeps a telemetry row unless a newer one is already there; false when it was older or malformed */
  const takeTelemetry = (row: Row, seenAt: number) => {
    const telemetry = telemetryFrom(row);
    const id = toNum(row.id);
    if (!telemetry || id === undefined) {
      ignore("robot_telemetry");
      return false;
    }
    const robot = robotEntry(telemetry.robot_id);
    if (id <= robot.telemetryId) return false;
    robot.telemetry = telemetry;
    robot.telemetryId = id;
    robot.seenAt = seenAt;
    return true;
  };

  const takeShelf = (row: Row, receivedAt: number) => {
    const data = shelfFrom(row);
    if (!data) {
      ignore("sensor_events");
      return null;
    }
    const reading = { data, receivedAt };
    shelves.set(data.shelf_id, reading);
    return reading;
  };

  /** A change from Realtime, live or after a load */
  const apply = (change: Change) => {
    const { table, type, row } = change;
    if (table === "robot_telemetry" && type === "INSERT") {
      if (takeTelemetry(row, change.at)) emitRobots();
    } else if (table === "robot_state" && type !== "DELETE") {
      const state = stateFrom(row);
      if (!state) return ignore(table);
      robotEntry(state.robot_id).state = state;
      emitRobots();
    } else if (table === "alerts" && type === "INSERT") {
      const alert = alertFrom(row);
      if (!alert) return ignore(table);
      const list = alerts ?? [];
      if (list.some((a) => a.alert_id === alert.alert_id)) return;
      alerts = [alert, ...list].slice(0, KEPT_ALERTS);
      emitAlerts();
    } else if (table === "alerts" && type === "DELETE") {
      // Deletes can't be filtered by farm and carry only the key: match on
      // alert_id (a UUID, so another farm's never matches here)
      const id = change.old.alert_id;
      if (!alerts || typeof id !== "string" || !alerts.some((a) => a.alert_id === id)) return;
      alerts = alerts.filter((a) => a.alert_id !== id);
      emitAlerts();
    } else if (table === "sensor_events" && type === "INSERT") {
      const reading = takeShelf(row, change.at);
      if (!reading) return;
      shelfHistory = [...shelfHistory, reading].slice(-KEPT_SHELF_READINGS);
      emitShelves();
      emitHistory();
    } else if (table === "farm_topology" && type !== "DELETE") {
      if (!isTopology(row.topology)) return ignore(table);
      topology = row.topology;
      resolveTopology();
    } else if (table === "alert_thresholds" && type !== "DELETE") {
      const next = thresholdsFrom(row.thresholds);
      if (!next) return ignore(table);
      thresholds = next;
      emitThresholds();
    }
  };

  /**
   * Loads one at a time: a second running alongside would stop the first's
   * buffering early, and its older rows would then overwrite newer changes.
   * A join during a load loads once more after it.
   */
  const load = async () => {
    if (loading) {
      loadAgain = true;
      return;
    }
    loading = true;
    try {
      do {
        loadAgain = false;
        await loadOnce();
      } while (loadAgain && db);
    } finally {
      loading = false;
    }
  };

  /** Robots with their latest telemetry, the latest alerts and shelf readings, the layout and the limits */
  const loadOnce = async () => {
    if (!db) return;
    const client = db;
    const loadGeneration = generation;
    clearTimeout(retryTimer);
    buffered = [];
    try {
      const [states, alertRows, shelfRows, topologyRows, thresholdRows] = await Promise.all([
        rowsOf(client.from("robot_state").select(STATE_COLUMNS).eq("farm_id", farmId)),
        rowsOf(
          client
            .from("alerts")
            .select(ALERT_COLUMNS)
            .eq("farm_id", farmId)
            // a batch shares one created_at
            .order("created_at", { ascending: false })
            .order("timestamp", { ascending: false })
            .limit(KEPT_ALERTS),
        ),
        rowsOf(
          client
            .from("sensor_events")
            .select(SENSOR_COLUMNS)
            .eq("farm_id", farmId)
            .order("created_at", { ascending: false })
            .limit(RECENT_SHELF_ROWS),
        ),
        rowsOf(client.from("farm_topology").select("topology").eq("farm_id", farmId).limit(1)),
        rowsOf(client.from("alert_thresholds").select("thresholds").eq("farm_id", farmId).limit(1)),
      ]);
      // Every robot the orchestrator knows has a robot_state row; each one's
      // newest telemetry through the (farm_id, robot_id, created_at) index. A
      // robot that reports without one turns up with its next row.
      const ids = [...new Set(states.map((row) => row.robot_id).filter((id): id is string => typeof id === "string"))];
      const telemetry = await Promise.all(
        ids.map((id) =>
          rowsOf(
            client
              .from("robot_telemetry")
              .select(TELEMETRY_COLUMNS)
              .eq("farm_id", farmId)
              .eq("robot_id", id)
              .order("created_at", { ascending: false })
              .limit(1),
          ),
        ),
      );
      if (loadGeneration !== generation) return;

      // Not through apply(): it emits per row, and a robot would flash with no telemetry
      states.forEach((row) => {
        const state = stateFrom(row);
        if (state) robotEntry(state.robot_id).state = state;
        else ignore("robot_state");
      });
      telemetry.flat().forEach((row) => takeTelemetry(row, toTime(row.created_at) ?? 0));

      // Authoritative: alerts deleted while away (a clear) are gone
      alerts = alertRows.map(alertFrom).filter((alert): alert is FarmAlert => {
        if (!alert) ignore("alerts");
        return alert !== null;
      });

      // newest first: the first row per shelf is its latest
      shelves.clear();
      shelfRows.forEach((row) => {
        if (typeof row.device === "string" && !shelves.has(row.device)) takeShelf(row, toTime(row.created_at) ?? 0);
      });

      const topologyRow = topologyRows[0];
      if (topologyRow && !isTopology(topologyRow.topology)) ignore("farm_topology");
      topology = topologyRow && isTopology(topologyRow.topology) ? topologyRow.topology : null;
      resolveTopology();
      thresholds = thresholdsFrom(thresholdRows[0]?.thresholds);
      warned.delete("load");
      // Supabase is back: a history that failed to load meanwhile tries again
      if (!historyLoaded && historyListeners.size > 0) void loadStoredHistory();
    } catch (err) {
      if (loadGeneration !== generation) return;
      warnOnce("load", `can't load the farm from Supabase, retrying: ${err instanceof Error ? err.message : err}`);
      retryTimer = setTimeout(() => void load(), RETRY_MS);
    } finally {
      if (loadGeneration === generation) {
        const changes = buffered ?? [];
        buffered = null;
        changes.forEach(apply);
        emitAll();
        updateConnection();
      }
    }
  };

  /** The History page's stored half, as means per bucket (shelf_history in sensor_events.sql) */
  const loadStoredHistory = async () => {
    if (!db || historyLoaded) return;
    const client = db;
    historyLoaded = true;
    try {
      // this browser's clock: a skew of minutes doesn't matter over 7 days
      const from = new Date(Date.now() - STORED_HISTORY_MS).toISOString();
      const rows: Row[] = [];
      while (rows.length < STORED_HISTORY_LIMIT) {
        const page = await rowsOf(
          client
            .rpc("shelf_history", { p_farm_id: farmId, p_from: from, p_bucket_ms: STORED_HISTORY_BUCKET_MS })
            .range(rows.length, rows.length + PAGE_ROWS - 1),
        );
        rows.push(...page);
        if (page.length < PAGE_ROWS) break;
      }
      // Buckets go by the Pi's clock and live readings by this browser's (no
      // clock sync): the stored ones stop where the live ones start
      const liveFrom = shelfHistory[0]?.receivedAt ?? Infinity;
      storedHistory = rows.reverse().flatMap((row) => {
        const start = toNum(row.bucket_start);
        if (start === undefined) return [];
        const data = shelfFrom({ ...row, ts: new Date(start).toISOString() });
        return data && start < liveFrom ? [{ data, receivedAt: start }] : [];
      });
      emitHistory();
    } catch (err) {
      historyLoaded = false;
      warnOnce("history", `no stored shelf history from Supabase: ${err instanceof Error ? err.message : err}`);
    }
  };

  const onChange = (table: string) => (payload: { eventType: Change["type"]; new: unknown; old: unknown }) => {
    const change: Change = {
      table,
      type: payload.eventType,
      row: isRecord(payload.new) ? payload.new : {},
      old: isRecord(payload.old) ? payload.old : {},
      at: Date.now(),
    };
    if (buffered) buffered.push(change);
    else apply(change);
  };

  const open = () => {
    const client = createClient(SUPABASE_URL!, SUPABASE_KEY!, {
      // No session: the operator's lives in httpOnly cookies for the server.
      // The publishable key is the token, as for any signed-out client, and
      // without Supabase Auth in the page there's no second auth client to warn about.
      accessToken: async () => SUPABASE_KEY!,
    });
    db = client;
    generation++;
    setConnection(CONNECTING);

    const statusChannel: RealtimeChannel = client.channel("farm-status", { config: { private: true } });
    statusChannel
      .on("presence", { event: "sync" }, () => {
        const online = (statusChannel.presenceState()[farmId] ?? []).length > 0;
        setConnection(online ? { state: "connected" } : FARM_OFFLINE);
      })
      .subscribe((status, err) => {
        if (db !== client) return;
        // SUBSCRIBED waits for the presence sync that follows it
        if (status === "SUBSCRIBED") return;
        console.warn(`[remote-source] farm-status ${status.toLowerCase()}${err ? `: ${err.message}` : ""}`);
        setConnection(UNREACHABLE);
      });

    let dataChannel: RealtimeChannel = client.channel("farm-data", { config: { private: true } });
    const follow = (table: string, event: "INSERT" | "*" | "DELETE", filtered = true) => {
      dataChannel = dataChannel.on(
        "postgres_changes",
        { event, schema: "public", table, ...(filtered ? { filter } : {}) },
        onChange(table),
      );
    };
    follow("robot_telemetry", "INSERT");
    follow("robot_state", "*");
    follow("alerts", "INSERT");
    follow("alerts", "DELETE", false);
    follow("sensor_events", "INSERT");
    follow("farm_topology", "*");
    follow("alert_thresholds", "*");
    dataChannel.subscribe((status, err) => {
      if (db !== client) return;
      if (status === "SUBSCRIBED") {
        warned.delete("farm-data");
        void load();
        return;
      }
      // supabase-js rejoins on its own, and the join loads again
      warnOnce("farm-data", `farm-data ${status.toLowerCase()}${err ? `: ${err.message}` : ""}, rejoining`);
    });
  };

  const close = () => {
    const client = db;
    db = null;
    generation++;
    clearTimeout(retryTimer);
    buffered = null;
    void client?.removeAllChannels();
  };

  const listening = () =>
    robotListeners.size > 0 || connectionListeners.size > 0 || alertListeners.size > 0 ||
    shelfListeners.size > 0 || historyListeners.size > 0 || thresholdListeners.size > 0;

  // Open while anything needs it: a listener, or a layout still loading
  const updateConnection = () => {
    if (!configured) return;
    const needed = listening() || topologyWaiters.size > 0;
    if (needed && !db) open();
    else if (!needed && db) close();
  };

  /** Removes a listener; a layout nobody else waits with resolves as the default, so the source can close */
  const release = <T>(listeners: Set<T>, listener: T) => {
    listeners.delete(listener);
    if (!listening()) resolveTopology();
    updateConnection();
  };

  return {
    mode: "remote",

    getTopology() {
      if (topology !== undefined || !configured) return Promise.resolve(topology ?? null);
      return new Promise((resolve) => {
        topologyWaiters.add(resolve);
        updateConnection();
      });
    },

    subscribeRobots(onRobots) {
      robotListeners.add(onRobots);
      updateConnection();
      onRobots(robotList());
      return () => release(robotListeners, onRobots);
    },

    async sendCommand(request, operatorKey) {
      // Never left waiting in Supabase for a farm that isn't there: a stop
      // delivered late is worse than an error
      if (connection.state !== "connected") throw new CommandError(connection.reason, 503);
      const response = await fetch("/api/commands", {
        method: "POST",
        headers: { "content-type": "application/json", "x-operator-key": operatorKey },
        body: JSON.stringify({ ...request, farm_id: farmId }),
      });
      const payload = await readJson<{ command: CommandRecord }>(response);
      return payload.command;
    },

    listRecentCommands(robotId) {
      return listCommandsFrom("/api/commands", robotId, farmId);
    },

    subscribeConnection(onChange) {
      connectionListeners.add(onChange);
      updateConnection();
      onChange(connection);
      return () => release(connectionListeners, onChange);
    },

    subscribeAlerts(onAlerts) {
      alertListeners.add(onAlerts);
      updateConnection();
      onAlerts(alerts);
      return () => release(alertListeners, onAlerts);
    },

    subscribeShelves(onShelves) {
      if (!configured) {
        onShelves(null);
        return () => undefined;
      }
      shelfListeners.add(onShelves);
      updateConnection();
      onShelves([...shelves.values()]);
      return () => release(shelfListeners, onShelves);
    },

    subscribeShelfHistory(onHistory) {
      if (!configured) {
        onHistory(null);
        return () => undefined;
      }
      historyListeners.add(onHistory);
      updateConnection();
      onHistory([...storedHistory, ...shelfHistory]);
      void loadStoredHistory();
      return () => release(historyListeners, onHistory);
    },

    subscribeThresholds(onThresholds) {
      thresholdListeners.add(onThresholds);
      updateConnection();
      onThresholds(thresholds);
      return () => release(thresholdListeners, onThresholds);
    },
  };
}
