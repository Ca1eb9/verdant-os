// ============================================================
// Payload validation — incoming MQTT JSON is untrusted until it
// matches the shared types. Invalid messages are dropped, never
// sent: a row Supabase refuses would hold up the rows behind it.
// Same checks as the ingester's, plus state and topology.
// ============================================================

import {
  type RobotTelemetry,
  type RobotStateUpdate,
  type ShelfSensorData,
  type FarmAlert,
  type FarmTopology,
  type AlertsCleared,
  AlertSeverity,
  RobotStatus,
  Heading,
} from "@farm/shared";

const STATUSES = new Set<string>(Object.values(RobotStatus));
const HEADINGS = new Set<unknown>([Heading.NORTH, Heading.EAST, Heading.SOUTH, Heading.WEST]);
const SEVERITIES = new Set<string>(Object.values(AlertSeverity));
const ALERT_SOURCES = new Set(["robot", "elevator", "shelf", "system"]);

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isLevel = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const optNum = (v: unknown) => v === undefined || isNum(v);
const nullableNum = (v: unknown) => v === null || isNum(v);
const optBool = (v: unknown) => v === undefined || typeof v === "boolean";
/** Unix ms that makes a valid date (sensor_events.ts is a timestamptz) */
const isTime = (v: unknown): v is number => isNum(v) && Number.isFinite(new Date(v).getTime());

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
    optBool(v.controller_connected) &&
    isNum(v.timestamp)
  );
}

export function isRobotStateUpdate(v: unknown): v is RobotStateUpdate {
  return (
    isObj(v) &&
    isStr(v.robot_id) &&
    STATUSES.has(v.status as string) &&
    (v.task === null || isObj(v.task)) &&
    Array.isArray(v.expected_path) && v.expected_path.every(isStr) &&
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
    isTime(v.timestamp)
  );
}

// metric may be empty: alerts that aren't about a reading (e.g. the
// orchestrator's) send "" with value and threshold 0
export function isAlert(v: unknown): v is FarmAlert {
  return (
    isObj(v) &&
    isStr(v.alert_id) &&
    SEVERITIES.has(v.severity as string) &&
    isStr(v.source) &&
    ALERT_SOURCES.has(v.source_type as string) &&
    isStr(v.message) &&
    typeof v.metric === "string" &&
    isNum(v.value) &&
    isNum(v.threshold) &&
    isNum(v.timestamp) &&
    (v.resolves === null || isStr(v.resolves))
  );
}

export function isAlertsCleared(v: unknown): v is AlertsCleared {
  return isObj(v) && isNum(v.timestamp);
}

/** Only its shape: the dashboard reads it as it is */
export function isTopology(v: unknown): v is FarmTopology {
  return isObj(v) && Array.isArray(v.nodes) && Array.isArray(v.edges);
}
