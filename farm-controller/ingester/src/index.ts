// ============================================================
// Telemetry ingester
//
// Subscribes to all robot, elevator, and shelf sensor telemetry.
// Logs to console and writes to SQLite for persistence.
//
// Run:  npx tsx src/index.ts
// ============================================================

import Database from "better-sqlite3";
import {
  type RobotTelemetry,
  type ElevatorTelemetry,
  type ShelfSensorData,
  TOPICS,
  extractIdFromTopic,
  createMqttClient,
} from "@farm/shared";

// --- Config --------------------------------------------------

const BROKER_URL = process.env.BROKER_URL ?? "mqtt://localhost:1883";
const DB_PATH = process.env.DB_PATH ?? "./farm_telemetry.db";

// --- Database setup ------------------------------------------

const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL"); // better concurrent read performance

db.exec(`
  CREATE TABLE IF NOT EXISTS robot_telemetry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    robot_id TEXT NOT NULL,
    status TEXT NOT NULL,
    current_node TEXT NOT NULL,
    battery_pct REAL NOT NULL,
    heading INTEGER NOT NULL,
    obstacle_cm REAL,
    temperature_c REAL NOT NULL,
    humidity_pct REAL NOT NULL,
    light_lux REAL NOT NULL,
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
    soil_moisture_pct REAL,
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

  CREATE INDEX IF NOT EXISTS idx_robot_ts ON robot_telemetry(timestamp);
  CREATE INDEX IF NOT EXISTS idx_shelf_ts ON shelf_sensors(timestamp);
  CREATE INDEX IF NOT EXISTS idx_robot_id ON robot_telemetry(robot_id, timestamp);
  CREATE INDEX IF NOT EXISTS idx_shelf_id ON shelf_sensors(shelf_id, timestamp);
`);

// Prepared statements for fast inserts
const insertRobot = db.prepare(`
  INSERT INTO robot_telemetry (robot_id, status, current_node, battery_pct, heading, obstacle_cm, temperature_c, humidity_pct, light_lux, timestamp)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertShelf = db.prepare(`
  INSERT INTO shelf_sensors (shelf_id, level, temperature_c, humidity_pct, light_lux, soil_moisture_pct, ph, timestamp)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertElevator = db.prepare(`
  INSERT INTO elevator_telemetry (elevator_id, current_level, status, target_level, load_detected, timestamp)
  VALUES (?, ?, ?, ?, ?, ?)
`);

// --- Counters for logging ------------------------------------

let counts = { robot: 0, shelf: 0, elevator: 0 };

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
  mqtt.subscribe<RobotTelemetry>(TOPICS.robot.telemetryAll, (msg, topic) => {
    const id = extractIdFromTopic(topic) ?? msg.robot_id;
    insertRobot.run(
      msg.robot_id,
      msg.status,
      msg.current_node,
      msg.battery_pct,
      msg.heading,
      msg.obstacle_cm,
      msg.temperature_c,
      msg.humidity_pct,
      msg.light_lux,
      msg.timestamp
    );
    counts.robot++;

    const arrow = ["N", "E", "S", "W"][msg.heading];
    console.log(
      `Robot: ${id} | ${msg.status.padEnd(16)} | ${arrow} ${msg.current_node} | Battery: ${msg.battery_pct}%`
    );
  });

  // --- Shelf sensors ---
  mqtt.subscribe<ShelfSensorData>(TOPICS.shelf.sensorsAll, (msg, topic) => {
    const id = extractIdFromTopic(topic) ?? msg.shelf_id;
    insertShelf.run(
      msg.shelf_id,
      msg.level,
      msg.temperature_c,
      msg.humidity_pct,
      msg.light_lux,
      msg.soil_moisture_pct,
      msg.ph,
      msg.timestamp
    );
    counts.shelf++;

    console.log(
      `Shelf: ${id} L${msg.level} | ${msg.temperature_c}°F | Water: ${msg.humidity_pct}% | Light: ${msg.light_lux} lux`
    );
  });

  // --- Elevator telemetry ---
  mqtt.subscribe<ElevatorTelemetry>(TOPICS.elevator.telemetryAll, (msg, topic) => {
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

  // --- Stats logging ---
  setInterval(() => {
    const total = counts.robot + counts.shelf + counts.elevator;
    if (total > 0) {
      console.log(
        `\nMessages ingested: ${total} total ` +
        `(robot: ${counts.robot}, shelf: ${counts.shelf}, elevator: ${counts.elevator})\n`
      );
    }
  }, 1_000);

  // --- Graceful shutdown ---
  process.on("SIGINT", async () => {
    console.log("\nIngester shutting down");
    const total = counts.robot + counts.shelf + counts.elevator;
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