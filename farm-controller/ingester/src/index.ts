// ============================================================
// Telemetry ingester
//
// Subscribes to all robot, elevator, and shelf sensor telemetry, and
// to operator commands. Logs to console and writes to SQLite for
// persistence.
//
// Run:  npx tsx src/index.ts
// ============================================================

import Database from "better-sqlite3";
import { TOPICS, extractIdFromTopic, createMqttClient } from "@farm/shared";
import { isCommand, isElevatorTelemetry, isRobotTelemetry, isShelfSensorData } from "./validate.js";

// --- Config --------------------------------------------------

const BROKER_URL = process.env.BROKER_URL ?? "mqtt://localhost:1883";
const DB_PATH = process.env.DB_PATH ?? "./farm_telemetry.db";

// --- Database setup ------------------------------------------

const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL"); // better concurrent read performance

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

  -- Sort by received_at: issued_at is the sender's clock (no clock sync)
  CREATE INDEX IF NOT EXISTS idx_commands_robot ON commands(robot_id, received_at);
  CREATE INDEX IF NOT EXISTS idx_robot_ts ON robot_telemetry(timestamp);
  CREATE INDEX IF NOT EXISTS idx_shelf_ts ON shelf_sensors(timestamp);
  CREATE INDEX IF NOT EXISTS idx_robot_id ON robot_telemetry(robot_id, timestamp);
  CREATE INDEX IF NOT EXISTS idx_shelf_id ON shelf_sensors(shelf_id, timestamp);
`);

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

// --- Counters for logging ------------------------------------

let counts = { robot: 0, shelf: 0, elevator: 0, command: 0 };

// --- Main ----------------------------------------------------

async function main() {
  const mqtt = await createMqttClient({
    serviceName: "ingester",
    brokerUrl: BROKER_URL,
  });

  console.log(`\n Ingester running`);
  console.log(`   Broker: ${BROKER_URL}`);
  console.log(`   Database: ${DB_PATH}\n`);

  // --- Robot telemetry ---
  mqtt.subscribe<unknown>(TOPICS.robot.telemetryAll, (msg, topic) => {
    if (!isRobotTelemetry(msg)) {
      console.warn(`Ignoring malformed robot telemetry on ${topic}`);
      return;
    }
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

    const arrow = msg.heading === null ? "-" : ["N", "E", "S", "W"][msg.heading];
    console.log(
      `Robot: ${id} | ${msg.status.padEnd(16)} | ${arrow} ${msg.current_node ?? "-"} | ` +
      `Task: ${msg.task_id ?? "-"} | Battery: ${msg.battery_pct}%`
    );
  });

  // --- Shelf sensors ---
  mqtt.subscribe<unknown>(TOPICS.shelf.sensorsAll, (msg, topic) => {
    if (!isShelfSensorData(msg)) {
      console.warn(`Ignoring malformed shelf reading on ${topic}`);
      return;
    }
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

    const waterLevel = msg.water_level_ok == null ? "-" : msg.water_level_ok ? "ok" : "LOW";
    console.log(
      `Shelf: ${id} L${msg.level} | Air: ${msg.temperature_c ?? "-"}°C ${msg.humidity_pct ?? "-"}% | ` +
      `Water: ${msg.water_temp_c ?? "-"}°C level ${waterLevel} pH ${msg.ph ?? "-"} | Light: ${msg.light_lux ?? "-"} lux`
    );
  });

  // --- Elevator telemetry ---
  mqtt.subscribe<unknown>(TOPICS.elevator.telemetryAll, (msg, topic) => {
    if (!isElevatorTelemetry(msg)) {
      console.warn(`Ignoring malformed elevator telemetry on ${topic}`);
      return;
    }
    const id = extractIdFromTopic(topic) ?? msg.elevator_id;
    insertElevator.run(
      msg.elevator_id,
      msg.current_level,
      msg.status,
      msg.target_level,
      msg.load_detected ? 1 : 0,
      msg.timestamp
    );
    counts.elevator++;

    console.log(
      `Elevator: ${id} | level ${msg.current_level} | ${msg.status}`
    );
  });

  // --- Operator commands ---
  mqtt.subscribe<unknown>(TOPICS.commands.all, (msg, topic) => {
    if (!isCommand(msg)) {
      console.warn(`Ignoring malformed command on ${topic}`);
      return;
    }
    if (msg.command.command === "jog") return;
    const channel = topic === TOPICS.commands.local ? "local" : "remote";
    const { changes } = insertCommand.run(msg.id, msg.robot_id ?? null, JSON.stringify(msg.command),
      msg.issued_by, msg.issued_at, channel, Date.now());
    if (!changes) return; // already stored
    counts.command++;
    console.log(`Command: ${msg.robot_id ?? "any"} | ${msg.command.command} (${channel})`);
  });

  // --- Stats logging ---
  setInterval(() => {
    const total = counts.robot + counts.shelf + counts.elevator + counts.command;
    if (total > 0) {
      console.log(
        `\nMessages ingested: ${total} total ` +
        `(robot: ${counts.robot}, shelf: ${counts.shelf}, elevator: ${counts.elevator}, ` +
        `command: ${counts.command})\n`
      );
    }
  }, 1_000);

  // --- Graceful shutdown ---
  process.on("SIGINT", async () => {
    console.log("\nIngester shutting down");
    const total = counts.robot + counts.shelf + counts.elevator + counts.command;
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