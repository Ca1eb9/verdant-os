import { RobotStatus } from "@farm/shared";

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

export function isShelfSensorData(value: unknown): value is Telemetry {
  if (!isRecord(value)) return false;
  return typeof value.shelf_id === "string" && value.shelf_id.length > 0 &&
    isFiniteNumber(value.level) &&
    isFiniteNumber(value.temperature_c) &&
    isFiniteNumber(value.humidity_pct) &&
    isFiniteNumber(value.light_lux) &&
    isFiniteNumber(value.soil_moisture_pct) &&
    isFiniteNumber(value.ph) &&
    isFiniteNumber(value.timestamp);
}

export function isElevatorTelemetry(value: unknown): value is Telemetry {
  if (!isRecord(value)) return false;
  return typeof value.elevator_id === "string" && value.elevator_id.length > 0 &&
    isFiniteNumber(value.current_level) &&
    ["idle", "moving", "loading", "error"].includes(value.status as string) &&
    isFiniteNumber(value.target_level) &&
    typeof value.load_detected === "boolean" &&
    isFiniteNumber(value.timestamp);
}
