// ============================================================
// SQL over the ingester's tables (farm-controller/ingester).
//
// Everything sorts and filters on received_at, the Pi's clock: a payload's
// timestamp / issued_at is the sender's (robots send millis(), there's no
// clock sync).
// ============================================================

import type { AlertSeverity, FarmAlert, RobotCommand, RobotTelemetry } from "@farm/shared";
import { LIMITS } from "./config.js";

/** The part of a SQLite connection the queries use (better-sqlite3, or node:sqlite in tests) */
export interface Db {
  prepare(sql: string): { all(...params: (string | number)[]): unknown[] };
}

type Row = Record<string, unknown>;

export type RobotTelemetryRecord = RobotTelemetry & { received_at: number };

export interface CommandRecord {
  id: string;
  robot_id: string | null;
  command: RobotCommand;
  issued_by: string;
  issued_at: number;
  status: "sent";
}

function toTelemetry(r: Row): RobotTelemetryRecord {
  const t: RobotTelemetryRecord = {
    robot_id: r.robot_id as string,
    status: r.status as RobotTelemetry["status"],
    current_node: (r.current_node as string | null) ?? null,
    task_id: (r.task_id as string | null) ?? null,
    last_completed_task_id: (r.last_completed_task_id as string | null) ?? null,
    battery_pct: r.battery_pct as number,
    heading: (r.heading as RobotTelemetry["heading"]) ?? null,
    obstacle_cm: (r.obstacle_cm as number | null) ?? null,
    timestamp: r.timestamp as number,
    received_at: r.received_at as number,
  };
  // Optional in the telemetry: left out when the robot didn't send them
  if (r.temperature_c != null) t.temperature_c = r.temperature_c as number;
  if (r.humidity_pct != null) t.humidity_pct = r.humidity_pct as number;
  if (r.light_lux != null) t.light_lux = r.light_lux as number;
  return t;
}

/**
 * Each robot's newest telemetry row. Steps through the robot ids on the index
 * rather than grouping the whole table, which grows by a row per robot per second.
 */
export function latestRobots(db: Db): RobotTelemetryRecord[] {
  return (db
    .prepare(
      `WITH RECURSIVE robots(robot_id) AS (
         SELECT MIN(robot_id) FROM robot_telemetry
         UNION ALL
         SELECT (SELECT MIN(robot_id) FROM robot_telemetry WHERE robot_id > robots.robot_id)
         FROM robots WHERE robots.robot_id IS NOT NULL
       )
       SELECT t.* FROM robots
       JOIN robot_telemetry t ON t.id = (
         SELECT id FROM robot_telemetry WHERE robot_id = robots.robot_id
         ORDER BY received_at DESC, id DESC LIMIT 1
       )
       ORDER BY t.robot_id`,
    )
    .all() as Row[]).map(toTelemetry);
}

export interface TelemetryQuery {
  robotId?: string;
  from: number;
  to: number;
  limit: number;
}

/** Telemetry received in [from, to], oldest first; the newest `limit` rows if there are more */
export function telemetryHistory(db: Db, q: TelemetryQuery): RobotTelemetryRecord[] {
  const where = ["received_at >= ?", "received_at <= ?"];
  const params: (string | number)[] = [q.from, q.to];
  if (q.robotId) {
    where.push("robot_id = ?");
    params.push(q.robotId);
  }
  const rows = db
    .prepare(
      `SELECT * FROM robot_telemetry WHERE ${where.join(" AND ")}
       ORDER BY received_at DESC, id DESC LIMIT ?`,
    )
    .all(...params, q.limit) as Row[];
  return rows.reverse().map(toTelemetry);
}

export interface AlertQuery {
  severity?: AlertSeverity;
  source?: string;
  limit: number;
}

/** FarmAlerts, newest received first */
export function recentAlerts(db: Db, q: AlertQuery): FarmAlert[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (q.severity) {
    where.push("severity = ?");
    params.push(q.severity);
  }
  if (q.source) {
    where.push("source = ?");
    params.push(q.source);
  }
  const rows = db
    .prepare(
      `SELECT alert_id, severity, source, source_type, message, metric, value, threshold, timestamp, resolves
       FROM alerts ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY received_at DESC LIMIT ?`,
    )
    .all(...params, q.limit) as Row[];
  return rows.map((r) => ({ ...r }) as unknown as FarmAlert);
}

/**
 * The last LIMITS.commands operator commands, newest received first, shaped
 * like the dashboard's own /api/commands. Rows whose command isn't valid JSON
 * are left out.
 */
export function recentCommands(db: Db, robotId: string | undefined): CommandRecord[] {
  const rows = db
    .prepare(
      `SELECT id, robot_id, command, issued_by, issued_at FROM commands
       WHERE json_valid(command) ${robotId ? "AND robot_id = ?" : ""}
       ORDER BY received_at DESC LIMIT ?`,
    )
    .all(...(robotId ? [robotId] : []), LIMITS.commands) as Row[];
  return rows.map((r) => ({
    id: r.id as string,
    robot_id: (r.robot_id as string | null) ?? null,
    command: JSON.parse(r.command as string) as RobotCommand,
    issued_by: r.issued_by as string,
    issued_at: r.issued_at as number,
    status: "sent",
  }));
}
