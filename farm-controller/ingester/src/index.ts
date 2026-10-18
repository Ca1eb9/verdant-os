// ============================================================
// Telemetry ingester
//
// Subscribes to all robot, elevator, and shelf sensor telemetry, to
// operator commands and to alerts, and writes them to SQLite for
// persistence, keeping RETENTION_DAYS of each. Logs a summary a minute.
//
// Run:  npx tsx src/index.ts
// ============================================================

import Database from "better-sqlite3";
import { TOPICS, extractIdFromTopic, createMqttClient, LogOnce } from "@farm/shared";
import { isAlert, isAlertsCleared, isCommand, isElevatorTelemetry, isRobotTelemetry, isShelfSensorData } from "./validate.js";

// --- Config --------------------------------------------------

const BROKER_URL = process.env.BROKER_URL ?? "mqtt://localhost:1883";
const DB_PATH = process.env.DB_PATH ?? "./farm_telemetry.db";
const DEFAULT_RETENTION_DAYS = 7;
/** Rows older than this are deleted, every table (alerts included, even open ones) */
const RETENTION_DAYS = (() => {
  const days = Number(process.env.RETENTION_DAYS ?? DEFAULT_RETENTION_DAYS);
  if (Number.isFinite(days) && days > 0) return days;
  console.warn(`RETENTION_DAYS must be a number of days above 0, got "${process.env.RETENTION_DAYS}": using ${DEFAULT_RETENTION_DAYS}`);
  return DEFAULT_RETENTION_DAYS;
})();
const DAY_MS = 24 * 60 * 60 * 1000;
/** Old rows are deleted at startup and this often */
const RETENTION_CHECK_MS = DAY_MS;
/** One line of what was stored this often, rather than a line per message */
const STATS_INTERVAL_MS = 60_000;

// --- Database setup ------------------------------------------

const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL"); // better concurrent read performance
// Each insert would otherwise wait on its own flush to the SD card. With WAL
// the card is flushed per checkpoint instead, a batch of rows at a time; a
// power cut can lose the last moments of rows, never corrupt the file.
db.pragma("synchronous = NORMAL");

// Tables from before task_id / nullable columns are rebuilt and their rows copied
const robotCols = db.prepare(`PRAGMA table_info(robot_telemetry)`).all() as { name: string }[];
const migrateRobot = robotCols.length > 0 && !robotCols.some((c) => c.name === "task_id");
// Tables that already have task_id only need the newer column added
const addLastCompleted = robotCols.some((c) => c.name === "task_id") &&
  !robotCols.some((c) => c.name === "last_completed_task_id");
if (migrateRobot) {
  db.exec(`
    ALTER TABLE robot_telemetry RENAME TO robot_telemetry_old;
    DROP INDEX IF EXISTS idx_robot_ts;
    DROP INDEX IF EXISTS idx_robot_id;
  `);
}

// Shelf tables from the soil-moisture contract are rebuilt for the reservoir sensors
const shelfCols = db.prepare(`PRAGMA table_info(shelf_sensors)`).all() as { name: string }[];
const migrateShelf = shelfCols.length > 0 && !shelfCols.some((c) => c.name === "water_temp_c");
if (migrateShelf) {
  db.exec(`
    ALTER TABLE shelf_sensors RENAME TO shelf_sensors_old;
    DROP INDEX IF EXISTS idx_shelf_ts;
    DROP INDEX IF EXISTS idx_shelf_id;
  `);
}

// Alert tables from before `resolves` only need the column added
const alertCols = db.prepare(`PRAGMA table_info(alerts)`).all() as { name: string }[];
const addResolves = alertCols.length > 0 && !alertCols.some((c) => c.name === "resolves");

db.exec(`
  CREATE TABLE IF NOT EXISTS robot_telemetry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    robot_id TEXT NOT NULL,
    status TEXT NOT NULL,
    current_node TEXT,
    task_id TEXT,
    last_completed_task_id TEXT,
    battery_pct REAL NOT NULL,
    heading INTEGER,
    obstacle_cm REAL,
    temperature_c REAL,
    humidity_pct REAL,
    light_lux REAL,
    timestamp INTEGER NOT NULL,
    received_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
  );

  CREATE TABLE IF NOT EXISTS shelf_sensors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shelf_id TEXT NOT NULL,
    level INTEGER NOT NULL,
    temperature_c REAL,
    humidity_pct REAL,
    light_lux REAL,
    water_temp_c REAL,
    water_level_ok INTEGER,
    ph REAL,
    timestamp INTEGER NOT NULL,
    received_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
  );

  CREATE TABLE IF NOT EXISTS elevator_telemetry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    elevator_id TEXT NOT NULL,
    current_level INTEGER NOT NULL,
    status TEXT NOT NULL,
    target_level INTEGER NOT NULL,
    load_detected INTEGER NOT NULL,
    timestamp INTEGER NOT NULL,
    received_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
  );

  -- Operator commands from farm/commands/local and /remote. command is the
  -- RobotCommand as JSON. Jogs aren't kept: one every 500 ms while driving.
  CREATE TABLE IF NOT EXISTS commands (
    id TEXT PRIMARY KEY,
    robot_id TEXT,
    command TEXT NOT NULL,
    issued_by TEXT NOT NULL,
    issued_at INTEGER NOT NULL,
    channel TEXT NOT NULL,
    received_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
  );

  -- FarmAlerts from farm/alerts, from every service.
  CREATE TABLE IF NOT EXISTS alerts (
    alert_id TEXT PRIMARY KEY,
    severity TEXT NOT NULL,
    source TEXT NOT NULL,
    source_type TEXT NOT NULL,
    message TEXT NOT NULL,
    metric TEXT NOT NULL,
    value REAL NOT NULL,
    threshold REAL NOT NULL,
    timestamp INTEGER NOT NULL,
    resolves TEXT,
    received_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
  );

  -- Sort by received_at: issued_at / timestamp is the sender's clock (no clock sync)
  CREATE INDEX IF NOT EXISTS idx_commands_robot ON commands(robot_id, received_at);
  CREATE INDEX IF NOT EXISTS idx_alerts_received ON alerts(received_at);
  CREATE INDEX IF NOT EXISTS idx_robot_ts ON robot_telemetry(timestamp);
  CREATE INDEX IF NOT EXISTS idx_shelf_ts ON shelf_sensors(timestamp);
  CREATE INDEX IF NOT EXISTS idx_robot_id ON robot_telemetry(robot_id, timestamp);
  -- For the Dashboard API: latest state and history by arrival time
  CREATE INDEX IF NOT EXISTS idx_robot_received ON robot_telemetry(robot_id, received_at);
  CREATE INDEX IF NOT EXISTS idx_robot_received_all ON robot_telemetry(received_at);
  CREATE INDEX IF NOT EXISTS idx_shelf_id ON shelf_sensors(shelf_id, timestamp);
  CREATE INDEX IF NOT EXISTS idx_shelf_received ON shelf_sensors(shelf_id, received_at);
  CREATE INDEX IF NOT EXISTS idx_shelf_received_all ON shelf_sensors(received_at);
`);

if (addResolves) {
  db.exec(`ALTER TABLE alerts ADD COLUMN resolves TEXT`);
}

if (addLastCompleted) {
  db.exec(`ALTER TABLE robot_telemetry ADD COLUMN last_completed_task_id TEXT`);
}

if (migrateRobot) {
  db.exec(`
    INSERT INTO robot_telemetry (robot_id, status, current_node, battery_pct, heading, obstacle_cm, temperature_c, humidity_pct, light_lux, timestamp, received_at)
      SELECT robot_id, status, current_node, battery_pct, heading, obstacle_cm, temperature_c, humidity_pct, light_lux, timestamp, received_at
      FROM robot_telemetry_old;
    DROP TABLE robot_telemetry_old;
  `);
  console.log("Migrated robot_telemetry table");
}

if (migrateShelf) {
  db.exec(`
    INSERT INTO shelf_sensors (shelf_id, level, temperature_c, humidity_pct, light_lux, ph, timestamp, received_at)
      SELECT shelf_id, level, temperature_c, humidity_pct, light_lux, ph, timestamp, received_at
      FROM shelf_sensors_old;
    DROP TABLE shelf_sensors_old;
  `);
  console.log("Migrated shelf_sensors table");
}

// Prepared statements for fast inserts
const insertRobot = db.prepare(`
  INSERT INTO robot_telemetry (robot_id, status, current_node, task_id, last_completed_task_id, battery_pct, heading, obstacle_cm, temperature_c, humidity_pct, light_lux, timestamp)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertShelf = db.prepare(`
  INSERT INTO shelf_sensors (shelf_id, level, temperature_c, humidity_pct, light_lux, water_temp_c, water_level_ok, ph, timestamp)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertElevator = db.prepare(`
  INSERT INTO elevator_telemetry (elevator_id, current_level, status, target_level, load_detected, timestamp)
  VALUES (?, ?, ?, ?, ?, ?)
`);

// A redelivered command (same id) is stored once. received_at in ms, not the
// column default's whole seconds, so commands sort in the order they came.
const insertCommand = db.prepare(`
  INSERT OR IGNORE INTO commands (id, robot_id, command, issued_by, issued_at, channel, received_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

// Same as commands: a redelivered alert is stored once, received_at in ms
const insertAlert = db.prepare(`
  INSERT OR IGNORE INTO alerts (alert_id, severity, source, source_type, message, metric, value, threshold, timestamp, resolves, received_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const deleteAlerts = db.prepare(`DELETE FROM alerts`);

// Every table's received_at is in ms (the Pi's clock)
const RETAINED_TABLES = ["robot_telemetry", "shelf_sensors", "elevator_telemetry", "commands", "alerts"];
const deleteOld = RETAINED_TABLES.map((table) => ({
  table,
  statement: db.prepare(`DELETE FROM ${table} WHERE received_at < ?`),
}));

/** Deletes rows older than RETENTION_DAYS, so the database stays a week long */
function deleteOldRows() {
  const before = Date.now() - RETENTION_DAYS * DAY_MS;
  try {
    const deleted = deleteOld.map(({ table, statement }) => `${table} ${statement.run(before).changes}`);
    console.log(`Deleted rows older than ${RETENTION_DAYS} days: ${deleted.join(", ")}`);
  } catch (err) {
    // Retried at the next check; never stop ingesting over it
    console.error("Could not delete old rows:", err);
  }
}

// --- Counters for logging ------------------------------------

/** Stored since the last stats line */
let counts = { robot: 0, shelf: 0, elevator: 0, command: 0, alert: 0 };
let totalStored = 0;
/** Malformed messages per topic: logged once until that topic is valid again */
const logs = new LogOnce();

// --- Main ----------------------------------------------------

async function main() {
  const mqtt = await createMqttClient({
    serviceName: "ingester",
    brokerUrl: BROKER_URL,
  });

  console.log(`\n Ingester running`);
  console.log(`   Broker: ${BROKER_URL}`);
  console.log(`   Database: ${DB_PATH} (rows kept ${RETENTION_DAYS} days)\n`);

  // --- Robot telemetry ---
  mqtt.subscribe<unknown>(TOPICS.robot.telemetryAll, (msg, topic) => {
    if (!isRobotTelemetry(msg)) {
      logs.warn(topic, `Ignoring malformed robot telemetry on ${topic} (logged once until it's valid again)`);
      return;
    }
    logs.ok(topic);
    // Topic id, same as the orchestrator uses
    const id = extractIdFromTopic(topic) ?? msg.robot_id;
    insertRobot.run(
      id,
      msg.status,
      msg.current_node ?? null,
      msg.task_id ?? null,
      msg.last_completed_task_id ?? null,
      msg.battery_pct,
      msg.heading ?? null,
      msg.obstacle_cm ?? null,
      msg.temperature_c ?? null,
      msg.humidity_pct ?? null,
      msg.light_lux ?? null,
      msg.timestamp
    );
    counts.robot++;
  });

  // --- Shelf sensors ---
  mqtt.subscribe<unknown>(TOPICS.shelf.sensorsAll, (msg, topic) => {
    if (!isShelfSensorData(msg)) {
      logs.warn(topic, `Ignoring malformed shelf reading on ${topic} (logged once until it's valid again)`);
      return;
    }
    logs.ok(topic);
    const id = extractIdFromTopic(topic) ?? msg.shelf_id;
    // SQLite has no boolean type
    const levelOk = msg.water_level_ok == null ? null : msg.water_level_ok ? 1 : 0;
    insertShelf.run(
      id,
      msg.level,
      msg.temperature_c ?? null,
      msg.humidity_pct ?? null,
      msg.light_lux ?? null,
      msg.water_temp_c ?? null,
      levelOk,
      msg.ph ?? null,
      msg.timestamp
    );
    counts.shelf++;
  });

  // --- Elevator telemetry ---
  mqtt.subscribe<unknown>(TOPICS.elevator.telemetryAll, (msg, topic) => {
    if (!isElevatorTelemetry(msg)) {
      logs.warn(topic, `Ignoring malformed elevator telemetry on ${topic} (logged once until it's valid again)`);
      return;
    }
    logs.ok(topic);
    insertElevator.run(
      msg.elevator_id,
      msg.current_level,
      msg.status,
      msg.target_level,
      msg.load_detected ? 1 : 0,
      msg.timestamp
    );
    counts.elevator++;
  });

  // --- Operator commands ---
  mqtt.subscribe<unknown>(TOPICS.commands.all, (msg, topic) => {
    if (!isCommand(msg)) {
      logs.warn(topic, `Ignoring malformed command on ${topic} (logged once until it's valid again)`);
      return;
    }
    logs.ok(topic);
    if (msg.command.command === "jog") return;
    const channel = topic === TOPICS.commands.local ? "local" : "remote";
    const { changes } = insertCommand.run(msg.id, msg.robot_id ?? null, JSON.stringify(msg.command),
      msg.issued_by, msg.issued_at, channel, Date.now());
    if (!changes) return; // already stored
    counts.command++;
    console.log(`Command: ${msg.robot_id ?? "any"} | ${msg.command.command} (${channel})`);
  });

  // --- Alerts ---
  mqtt.subscribe<unknown>(TOPICS.alerts, (msg, topic) => {
    if (!isAlert(msg)) {
      logs.warn(topic, `Ignoring malformed alert on ${topic} (logged once until it's valid again)`);
      return;
    }
    logs.ok(topic);
    const { changes } = insertAlert.run(msg.alert_id, msg.severity, msg.source, msg.source_type,
      msg.message, msg.metric, msg.value, msg.threshold, msg.timestamp, msg.resolves, Date.now());
    if (!changes) return; // already stored
    counts.alert++;
    console.log(`Alert: ${msg.severity} | ${msg.source} | ${msg.message}`);
  });

  // npm run clear-alerts: the alert history starts over
  mqtt.subscribe<unknown>(TOPICS.alertsClear, (msg, topic) => {
    if (!isAlertsCleared(msg)) {
      logs.warn(topic, `Ignoring malformed clear on ${topic} (logged once until it's valid again)`);
      return;
    }
    logs.ok(topic);
    const { changes } = deleteAlerts.run();
    console.log(`Alerts cleared: deleted ${changes} stored alerts`);
  });

  // --- Stats logging ---
  setInterval(() => {
    const total = counts.robot + counts.shelf + counts.elevator + counts.command + counts.alert;
    if (total > 0) {
      console.log(
        `Stored in the last ${STATS_INTERVAL_MS / 1000} s: ${total} ` +
        `(robot: ${counts.robot}, shelf: ${counts.shelf}, elevator: ${counts.elevator}, ` +
        `command: ${counts.command}, alert: ${counts.alert})`
      );
    }
    totalStored += total;
    counts = { robot: 0, shelf: 0, elevator: 0, command: 0, alert: 0 };
  }, STATS_INTERVAL_MS);

  // --- Retention ---
  deleteOldRows();
  setInterval(deleteOldRows, RETENTION_CHECK_MS);

  // --- Graceful shutdown ---
  process.on("SIGINT", async () => {
    console.log("\nIngester shutting down");
    const total = totalStored + counts.robot + counts.shelf + counts.elevator + counts.command + counts.alert;
    console.log(`   Total messages stored: ${total}`);
    db.close();
    await mqtt.disconnect();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Ingester failed:", err);
  process.exit(1);
});