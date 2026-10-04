// ============================================================
// Payload validation — incoming MQTT JSON is untrusted until it
// matches the shared types. Invalid messages are dropped, not
// stored: a wrong type in SQLite would be read back as real data.
// ============================================================

import {
  type RobotTelemetry,
  type ElevatorTelemetry,
  type ShelfSensorData,
  type RemoteCommand,
  RobotStatus,
  Heading,
} from "@farm/shared";

const STATUSES = new Set<string>(Object.values(RobotStatus));
const HEADINGS = new Set<unknown>([Heading.NORTH, Heading.EAST, Heading.SOUTH, Heading.WEST]);
const ELEVATOR_STATUSES = new Set(["idle", "moving", "loading", "error"]);

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isLevel = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const optNum = (v: unknown) => v === undefined || isNum(v);
const nullableNum = (v: unknown) => v === null || isNum(v);

export function isRobotTelemetry(v: unknown): v is RobotTelemetry {
  return (
    isObj(v) &&
    isStr(v.robot_id) &&
    STATUSES.has(v.status as string) &&
    (v.current_node === null || isStr(v.current_node)) &&
    (v.task_id === null || isStr(v.task_id)) &&
    (v.last_completed_task_id === null || isStr(v.last_completed_task_id)) &&
    isNum(v.battery_pct) &&
    (v.heading === null || HEADINGS.has(v.heading)) &&
    (v.obstacle_cm === undefined || nullableNum(v.obstacle_cm)) &&
    optNum(v.temperature_c) &&
    optNum(v.humidity_pct) &&
    optNum(v.light_lux) &&
    isNum(v.timestamp)
  );
}

export function isShelfSensorData(v: unknown): v is ShelfSensorData {
  return (
    isObj(v) &&
    isStr(v.shelf_id) &&
    isLevel(v.level) &&
    nullableNum(v.temperature_c) &&
    nullableNum(v.humidity_pct) &&
    nullableNum(v.light_lux) &&
    nullableNum(v.water_temp_c) &&
    (v.water_level_ok === null || typeof v.water_level_ok === "boolean") &&
    nullableNum(v.ph) &&
    isNum(v.timestamp)
  );
}

export function isElevatorTelemetry(v: unknown): v is ElevatorTelemetry {
  return (
    isObj(v) &&
    isStr(v.elevator_id) &&
    isLevel(v.current_level) &&
    ELEVATOR_STATUSES.has(v.status as string) &&
    isLevel(v.target_level) &&
    typeof v.load_detected === "boolean" &&
    isNum(v.timestamp)
  );
}

/** Only what the commands table needs; the orchestrator checks the command itself */
export function isCommand(v: unknown): v is RemoteCommand {
  return (
    isObj(v) &&
    isStr(v.id) &&
    (v.robot_id === undefined || typeof v.robot_id === "string") &&
    isObj(v.command) &&
    typeof v.command.command === "string" &&
    typeof v.issued_by === "string" &&
    isNum(v.issued_at)
  );
}
