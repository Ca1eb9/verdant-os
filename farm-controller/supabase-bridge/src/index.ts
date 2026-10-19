// ============================================================
// Supabase bridge
//
// Syncs this farm's MQTT bus with the team's Supabase project, for
// the remote dashboard: relays remote commands in, mirrors farm
// data out and marks the farm online. One bridge per farm (Pi).
//
// Run:  npx tsx src/index.ts
// Env:  deploy/env/supabase-bridge.env.example
// ============================================================

import { fileURLToPath } from "url";
import { setTimeout as sleep } from "timers/promises";
import { performance } from "perf_hooks";
import { createClient, type RealtimeChannel } from "@supabase/supabase-js";
import { createMqttClient, extractIdFromTopic, LogOnce, TOPICS, type TypedMqttClient } from "@farm/shared";

import { toRemoteCommand } from "./commands.js";
import { loadConfig, loadEnv, type BridgeConfig, type BridgeEnv } from "./config.js";
import { Outbox } from "./outbox.js";
import {
  isAlert, isAlertsCleared, isRobotStateUpdate, isRobotTelemetry, isShelfSensorData, isTopology,
} from "./validate.js";

// --- Config --------------------------------------------------

const CONFIG_PATH = process.env.CONFIG_PATH ?? "../../supabase-bridge-config.json";

let env: BridgeEnv;
let config: BridgeConfig;
try {
  env = loadEnv(process.env);
} catch (err) {
  console.error(`[FATAL] Bad supabase bridge settings: ${(err as Error).message}`);
  process.exit(1);
}
try {
  config = loadConfig(fileURLToPath(new URL(CONFIG_PATH, import.meta.url)));
} catch (err) {
  console.error(`[FATAL] Bad supabase bridge config (${CONFIG_PATH}): ${(err as Error).message}`);
  process.exit(1);
}

const supabase = createClient(env.supabaseUrl, env.serviceKey, {
  // A server key: no user session to keep or refresh
  auth: { persistSession: false, autoRefreshToken: false },
});

let mqtt: TypedMqttClient;
let shuttingDown = false;
const logs = new LogOnce();

// --- Startup check -------------------------------------------

/**
 * A FARM_ID with no farms row can't write anything (the foreign keys refuse
 * it), so that and a rejected key stop the bridge. Anything else (no
 * internet at boot) is retried: the farm must not need the cloud to start.
 */
async function waitForFarm(): Promise<string> {
  for (;;) {
    const { data, error, status } = await supabase
      .from("farms")
      .select("name")
      .eq("id", env.farmId)
      .maybeSingle();

    if (!error && data) {
      logs.ok("farm check", "[BRIDGE] Supabase reachable again");
      return data.name as string;
    }
    if (!error) {
      throw new Error(`no row in the farms table with id "${env.farmId}": add it (docs/SUPABASE-SETUP.md, step 3) or fix FARM_ID`);
    }
    if (status === 401) {
      throw new Error(`Supabase refused the key (${error.message}): check SUPABASE_SERVICE_ROLE_KEY`);
    }
    // Postgres insufficient_privilege: the key is fine, the role has no grant on the table
    if (error.code === "42501") {
      throw new Error(`Supabase accepted the key but the database refused it (${error.message}): the tables are missing their grants`);
    }
    logs.warn("farm check",
      `[BRIDGE] Can't reach Supabase to check the farm (${error.message}), retrying every ${config.retry_interval_ms} ms (logged once)`);
    await sleep(config.retry_interval_ms);
  }
}

// --- Inbound: remote commands --------------------------------
//
// Realtime only says a row arrived; each drain then reads every pending row
// of this farm from the table, oldest first. That also picks up rows
// inserted while the bridge was offline, on every (re)connect.

let draining = false;
let drainAgain = false;

/** Runs drains one at a time; a trigger during a drain runs one more after it */
async function drainCommands() {
  if (draining) {
    drainAgain = true;
    return;
  }
  draining = true;
  try {
    do {
      drainAgain = false;
      await drainOnce();
    } while (drainAgain);
    logs.ok("commands", "[CMD] Relaying remote commands again");
  } catch (err) {
    logs.warn("commands", `[CMD] Can't relay remote commands: ${(err as Error).message} (logged once; retried on the next reconnect or command)`);
  } finally {
    draining = false;
  }
}

async function drainOnce() {
  // Never let mqtt.js queue a command to send late: it stays pending (and
  // goes stale if the broker is gone long) until the broker is back
  if (!mqtt?.raw.connected) return;

  const stale = await supabase.rpc("fail_stale_remote_commands", {
    p_farm_id: env.farmId,
    p_max_age_ms: config.stale_command_ms,
  });
  if (stale.error) throw new Error(stale.error.message);
  for (const id of (stale.data ?? []) as string[]) console.warn(`[CMD] ${id} failed: stale`);

  const { data: rows, error } = await supabase
    .from("remote_commands")
    .select("id, robot_id, command, issued_by, issued_at")
    .eq("farm_id", env.farmId)
    .eq("status", "pending")
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);

  for (const row of rows ?? []) {
    if (!mqtt.raw.connected) return;
    const remote = toRemoteCommand(row);
    if (typeof remote === "string") {
      await finishCommand(String(row.id), "failed", remote);
      console.warn(`[CMD] ${row.id} failed: ${remote}`);
      continue;
    }
    mqtt.publish(TOPICS.commands.remote, remote);
    await finishCommand(remote.id, "sent");
    console.log(`[CMD] ${remote.id} sent: ${remote.command.command} → ${remote.robot_id} (by ${remote.issued_by})`);
  }
}

async function finishCommand(id: string, status: "sent" | "failed", reason?: string) {
  const { data, error } = await supabase.rpc("finish_remote_command", {
    p_id: id,
    p_farm_id: env.farmId,
    p_status: status,
    p_error: reason ?? null,
  });
  if (error) throw new Error(error.message);
  if (data !== true) console.warn(`[CMD] ${id} was no longer pending when marked ${status}`);
}

function subscribeCommands() {
  supabase
    .channel(`remote-commands:${env.farmId}`, { config: { private: true } })
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "remote_commands", filter: `farm_id=eq.${env.farmId}` },
      () => void drainCommands(),
    )
    .subscribe((status, err) => {
      if (status === "SUBSCRIBED") {
        logs.ok("realtime", "[CMD] Realtime connected again");
        console.log("[CMD] Listening for remote commands");
        void drainCommands();
      } else if (!shuttingDown) {
        // supabase-js rejoins on its own
        logs.warn("realtime", `[CMD] Realtime ${status.toLowerCase()}${err ? `: ${err.message}` : ""}, rejoining (logged once)`);
      }
    });
}

// --- Presence: farm online ----------------------------------
//
// The remote dashboard shows a farm online while its key is in the
// farm-status channel's presence state. The farm is the MQTT bus, so the
// bridge tracks only while it's connected to the broker. If the bridge
// loses the internet, Supabase drops the key on its own.

let statusChannel: RealtimeChannel | null = null;
let statusJoined = false;

/** Tracks while the broker is connected, untracks while it isn't */
async function updatePresence() {
  if (!statusChannel || !statusJoined) return;
  const online = mqtt?.raw.connected ?? false;
  const result = online
    ? await statusChannel.track({ farm_id: env.farmId, service: "supabase-bridge", online_at: new Date().toISOString() })
    : await statusChannel.untrack();
  if (result === "ok") {
    logs.ok("presence");
    console.log(`[PRESENCE] Farm ${online ? "online" : "offline (broker down)"}`);
  } else {
    // The channel retracks when it rejoins
    logs.warn("presence", `[PRESENCE] Couldn't ${online ? "track" : "untrack"} (${result}), retrying on rejoin (logged once)`);
  }
}

function joinStatusChannel() {
  statusChannel = supabase.channel("farm-status", {
    config: { private: true, presence: { key: env.farmId } },
  });
  statusChannel.subscribe((status, err) => {
    // Presence is lost with the connection: track again on every join
    statusJoined = status === "SUBSCRIBED";
    if (statusJoined) {
      logs.ok("status channel");
      void updatePresence();
    } else if (!shuttingDown) {
      logs.warn("status channel", `[PRESENCE] Channel ${status.toLowerCase()}${err ? `: ${err.message}` : ""}, rejoining (logged once)`);
    }
  });
}

// --- Outbound: mirror the farm --------------------------------
//
// Every row carries this farm's id: MQTT has none (one Pi, one farm).
// Ids come from the topic, as the ingester and orchestrator take them.

let outbox: Outbox;

interface Sample {
  /** Monotonic ms (performance.now); the Pi's wall clock can jump */
  at: number;
  status?: string;
  node?: string | null;
}
const lastTelemetry = new Map<string, Sample>();
const lastReading = new Map<string, Sample>();

/** Keeps a row per interval, or at once when the robot's status or node changed */
function due(samples: Map<string, Sample>, id: string, now: number, status?: string, node?: string | null) {
  const last = samples.get(id);
  const changed = last !== undefined && (last.status !== status || last.node !== node);
  if (last && !changed && now - last.at < config.sample_interval_ms) return false;
  samples.set(id, { at: now, status, node });
  return true;
}

/** A malformed message logs once per topic until a valid one arrives */
function invalid(topic: string, what: string) {
  logs.warn(`invalid ${topic}`, `[OUT] Ignoring malformed ${what} on ${topic} (logged once until it's valid again)`);
}

function subscribeOutbound() {
  mqtt.subscribe<unknown>(TOPICS.robot.telemetryAll, (msg, topic) => {
    if (!isRobotTelemetry(msg)) return invalid(topic, "telemetry");
    logs.ok(`invalid ${topic}`);
    const id = extractIdFromTopic(topic) ?? msg.robot_id;
    if (!due(lastTelemetry, id, performance.now(), msg.status, msg.current_node)) return;
    outbox.add({
      kind: "telemetry",
      row: {
        farm_id: env.farmId,
        robot_id: id,
        status: msg.status,
        current_node: msg.current_node,
        task_id: msg.task_id,
        last_completed_task_id: msg.last_completed_task_id,
        battery_pct: msg.battery_pct,
        heading: msg.heading,
        obstacle_cm: msg.obstacle_cm ?? null,
        temperature_c: msg.temperature_c ?? null,
        humidity_pct: msg.humidity_pct ?? null,
        light_lux: msg.light_lux ?? null,
        timestamp: msg.timestamp,
        // The Pi's receive time: a robot's timestamp is its uptime
        received_at: Date.now(),
      },
    });
  });

  mqtt.subscribe<unknown>(TOPICS.robot.stateAll, (msg, topic) => {
    if (!isRobotStateUpdate(msg)) return invalid(topic, "robot state");
    logs.ok(`invalid ${topic}`);
    const id = extractIdFromTopic(topic) ?? msg.robot_id;
    outbox.add({
      kind: "state",
      key: id,
      row: {
        farm_id: env.farmId,
        robot_id: id,
        status: msg.status,
        task: msg.task,
        expected_path: msg.expected_path,
        timestamp: msg.timestamp,
      },
    });
  });

  mqtt.subscribe<unknown>(TOPICS.alerts, (msg, topic) => {
    if (!isAlert(msg)) return invalid(topic, "alert");
    logs.ok(`invalid ${topic}`);
    outbox.add({
      kind: "alert",
      row: {
        farm_id: env.farmId,
        alert_id: msg.alert_id,
        severity: msg.severity,
        source: msg.source,
        source_type: msg.source_type,
        message: msg.message,
        metric: msg.metric,
        value: msg.value,
        threshold: msg.threshold,
        timestamp: msg.timestamp,
        resolves: msg.resolves,
      },
    });
  });

  mqtt.subscribe<unknown>(TOPICS.alertsClear, (msg, topic) => {
    if (!isAlertsCleared(msg)) return invalid(topic, "alert clear");
    logs.ok(`invalid ${topic}`);
    outbox.add({ kind: "clear" });
    console.log("[OUT] Alerts cleared: this farm's alerts will be deleted from Supabase");
  });

  mqtt.subscribe<unknown>(TOPICS.system.topology, (msg, topic) => {
    if (!isTopology(msg)) return invalid(topic, "topology");
    logs.ok(`invalid ${topic}`);
    outbox.add({ kind: "topology", key: env.farmId, row: { farm_id: env.farmId, topology: msg } });
  });

  mqtt.subscribe<unknown>(TOPICS.shelf.sensorsAll, (msg, topic) => {
    if (!isShelfSensorData(msg)) return invalid(topic, "shelf reading");
    logs.ok(`invalid ${topic}`);
    const id = extractIdFromTopic(topic) ?? msg.shelf_id;
    if (!due(lastReading, id, performance.now())) return;
    outbox.add({
      kind: "sensor",
      row: {
        farm_id: env.farmId,
        device: id,
        source: "supabase-bridge",
        ts: new Date(msg.timestamp).toISOString(),
        air_temp_c: msg.temperature_c,
        humidity_pct: msg.humidity_pct,
        water_temp_c: msg.water_temp_c,
        water_level_ok: msg.water_level_ok,
        ph: msg.ph,
        light_lux: msg.light_lux,
      },
    });
  });
}

function logStats() {
  const stats = outbox.takeStats();
  if (stats.size === 0) return;
  const parts = [...stats].map(([kind, n]) => `${kind}: ${n}`).join(", ");
  console.log(`[OUT] Sent in the last ${config.stats_interval_ms / 1000} s: ${parts} (${outbox.size} waiting)`);
}

// --- Main ----------------------------------------------------

async function main() {
  console.log("[BRIDGE] Supabase bridge starting");
  console.log(`[BRIDGE]   farm:     ${env.farmId}`);
  console.log(`[BRIDGE]   supabase: ${env.supabaseUrl}`);
  console.log(`[BRIDGE]   broker:   ${env.brokerUrl}`);

  const farmName = await waitForFarm();
  console.log(`[BRIDGE] Farm "${env.farmId}" (${farmName}) found in Supabase`);

  mqtt = await createMqttClient({
    serviceName: "supabase-bridge",
    brokerUrl: env.brokerUrl,
    onConnect: () => {
      void updatePresence();
      // Commands that waited for the broker
      void drainCommands();
    },
    onDisconnect: () => void updatePresence(),
  });
  outbox = new Outbox(supabase, {
    farmId: env.farmId,
    maxBatchRows: config.max_batch_rows,
    maxBufferRows: config.max_buffer_rows,
  }, logs);
  subscribeOutbound();
  const flushTimer = setInterval(() => void outbox.flush(), config.flush_interval_ms);
  const statsTimer = setInterval(logStats, config.stats_interval_ms);
  joinStatusChannel();
  subscribeCommands();
  console.log("[BRIDGE] Running");

  const shutdown = async () => {
    // A second Ctrl+C, or SIGTERM after SIGINT, mustn't start another
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("[BRIDGE] Shutting down");
    clearInterval(flushTimer);
    clearInterval(statsTimer);
    // Send what's waiting, and leave farm-status (offline right away);
    // without internet neither would ever finish
    await Promise.race([
      Promise.all([outbox.finish(), supabase.removeAllChannels()]),
      sleep(config.shutdown_timeout_ms),
    ]);
    if (outbox.size > 0) console.warn(`[OUT] ${outbox.size} row(s) not sent before stopping`);
    await mqtt.disconnect();
    process.exit(0);
  };
  // systemd stops services with SIGTERM
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[FATAL] Supabase bridge failed:", (err as Error).message);
  process.exit(1);
});
