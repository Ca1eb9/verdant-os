import { AlertSeverity, RobotStatus, type FarmAlert } from "@farm/shared";

type Telemetry = Record<string, unknown>;

function isRecord(value: unknown): value is Telemetry {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || value === null || isFiniteNumber(value);
}

function isNullableNumber(value: unknown): boolean {
  return value === null || isFiniteNumber(value);
}

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

export function isRobotTelemetry(value: unknown): value is Telemetry {
  if (!isRecord(value)) return false;
  return typeof value.robot_id === "string" && value.robot_id.length > 0 &&
    Object.values(RobotStatus).includes(value.status as RobotStatus) &&
    isNullableString(value.current_node) &&
    isNullableString(value.task_id) &&
    isNullableString(value.last_completed_task_id) &&
    isFiniteNumber(value.battery_pct) &&
    (value.heading === null ||
      (Number.isInteger(value.heading) && (value.heading as number) >= 0 && (value.heading as number) <= 3)) &&
    isOptionalNumber(value.obstacle_cm) &&
    isOptionalNumber(value.temperature_c) &&
    isOptionalNumber(value.humidity_pct) &&
    isOptionalNumber(value.light_lux) &&
    isFiniteNumber(value.timestamp);
}

/** Each reading is null when its sensor failed to read */
export function isShelfSensorData(value: unknown): value is Telemetry {
  if (!isRecord(value)) return false;
  return typeof value.shelf_id === "string" && value.shelf_id.length > 0 &&
    Number.isInteger(value.level) &&
    isNullableNumber(value.temperature_c) &&
    isNullableNumber(value.humidity_pct) &&
    isNullableNumber(value.light_lux) &&
    isNullableNumber(value.water_temp_c) &&
    (value.water_level_ok === null || typeof value.water_level_ok === "boolean") &&
    isNullableNumber(value.ph) &&
    isFiniteNumber(value.timestamp);
}

const ALERT_SOURCES = ["robot", "elevator", "shelf", "system"];

export function isFarmAlert(value: unknown): value is FarmAlert {
  if (!isRecord(value)) return false;
  return typeof value.alert_id === "string" && value.alert_id.length > 0 &&
    Object.values(AlertSeverity).includes(value.severity as AlertSeverity) &&
    typeof value.source === "string" &&
    ALERT_SOURCES.includes(value.source_type as string) &&
    typeof value.message === "string" &&
    typeof value.metric === "string" &&
    isFiniteNumber(value.value) &&
    isFiniteNumber(value.threshold) &&
    isFiniteNumber(value.timestamp) &&
    (value.resolves === null || (typeof value.resolves === "string" && value.resolves.length > 0));
}
