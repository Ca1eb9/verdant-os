// Checks for farm data from outside the browser: MQTT payloads on FarmNet
// (local-source.ts) and Supabase rows remotely (remote-source.ts). Neither is
// trusted until it matches the shared types (farm-controller/shared/src/types.ts).

import type {
  AlertSeverity,
  FarmAlert,
  FarmTopology,
  RemoteCommand,
  RobotStateUpdate,
  RobotStatus,
  RobotTelemetry,
  ShelfSensorData,
  ThresholdLimits,
} from "@/lib/farm/types";

const STATUSES: RobotStatus[] = [
  "idle", "en_route", "working", "returning_to_dock", "docking", "charging",
  "stopped", "lost", "error", "manual", "initializing",
];
const NODE_TYPES = ["checkpoint", "elevator", "dock", "water"];
const COMMANDS = [
  "navigate", "return_to_dock", "stop", "resume", "cancel", "jog", "connect_controller", "charge_complete",
];
const SEVERITIES: AlertSeverity[] = ["info", "warning", "critical"];
const ALERT_SOURCES = ["robot", "elevator", "shelf", "system"];

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
export const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStrOrNull = (v: unknown) => v === null || typeof v === "string";
const isOptStr = (v: unknown) => v === undefined || typeof v === "string";
const isNumOrNull = (v: unknown) => v === null || isNum(v);

export function isTelemetry(v: unknown): v is RobotTelemetry {
  return isRecord(v) &&
    STATUSES.includes(v.status as RobotStatus) &&
    isStrOrNull(v.current_node) &&
    isNum(v.battery_pct) &&
    (v.heading === null || v.heading === 0 || v.heading === 1 || v.heading === 2 || v.heading === 3);
}

export function isStateUpdate(v: unknown): v is RobotStateUpdate {
  if (!isRecord(v) || !STATUSES.includes(v.status as RobotStatus)) return false;
  if (!Array.isArray(v.expected_path) || !v.expected_path.every((n) => typeof n === "string")) return false;
  const t = v.task;
  return t === null || (isRecord(t) && typeof t.task_id === "string" && typeof t.type === "string" &&
    (t.target_node === undefined || typeof t.target_node === "string"));
}

export function isTopology(v: unknown): v is FarmTopology {
  return isRecord(v) && Array.isArray(v.nodes) && Array.isArray(v.edges) &&
    v.nodes.every((n) => isRecord(n) && typeof n.id === "string" && isNum(n.x) && isNum(n.y) &&
      isNum(n.z) && NODE_TYPES.includes(n.type as string)) &&
    v.edges.every((e) => isRecord(e) && typeof e.from === "string" && typeof e.to === "string");
}

// Only the fields the history shows; the orchestrator validates the rest
export function isCommand(v: unknown): v is RemoteCommand {
  if (!isRecord(v) || !isRecord(v.command)) return false;
  const c = v.command;
  return typeof v.id === "string" && typeof v.robot_id === "string" && typeof v.issued_by === "string" &&
    isNum(v.issued_at) && COMMANDS.includes(c.command as string) && isOptStr(c.target_node) &&
    isOptStr(c.task_id) && (c.immediate === undefined || typeof c.immediate === "boolean");
}

export function isAlert(v: unknown): v is FarmAlert {
  return isRecord(v) && typeof v.alert_id === "string" && v.alert_id.length > 0 &&
    SEVERITIES.includes(v.severity as AlertSeverity) && typeof v.source === "string" &&
    ALERT_SOURCES.includes(v.source_type as string) && typeof v.message === "string" &&
    typeof v.metric === "string" && isNum(v.value) && isNum(v.threshold) && isNum(v.timestamp) &&
    (v.resolves === null || (typeof v.resolves === "string" && v.resolves.length > 0));
}

export function isThresholdLimits(v: unknown): v is ThresholdLimits {
  return isRecord(v) && typeof v.metric === "string" && v.metric.length > 0 &&
    isNum(v.critical_min) && isNum(v.warning_min) && isNum(v.warning_max) && isNum(v.critical_max) &&
    v.critical_min <= v.warning_min && v.warning_min < v.warning_max && v.warning_max <= v.critical_max;
}

export function isShelfData(v: unknown): v is ShelfSensorData {
  return isRecord(v) && typeof v.shelf_id === "string" && v.shelf_id.length > 0 &&
    Number.isInteger(v.level) && isNumOrNull(v.temperature_c) && isNumOrNull(v.humidity_pct) &&
    isNumOrNull(v.light_lux) && isNumOrNull(v.water_temp_c) &&
    (v.water_level_ok === null || typeof v.water_level_ok === "boolean") && isNumOrNull(v.ph) &&
    isNum(v.timestamp);
}
