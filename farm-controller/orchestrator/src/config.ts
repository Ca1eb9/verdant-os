import { readFileSync } from "fs";
import type { OrchestratorConfig } from "@farm/shared";

const DEFAULTS: OrchestratorConfig = {
  watchdog_interval_ms: 5000,
  heartbeat_timeout_ms: 30000,
  battery_low_pct: 20,
  battery_critical_pct: 15,
  battery_assign_margin_pct: 10,
  battery_failsafe: true,
  unknown_node_alert_count: 3,
  command_ack_timeout_ms: 5000,
  completed_task_limit: 200,
  max_task_retries: 2,
  task_retry_delay_ms: 60000,
  plant_schedules: [],
  scheduler_interval_ms: 60000,
  robot_plants: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

const POSITIVE_MS = [
  "watchdog_interval_ms",
  "heartbeat_timeout_ms",
  "command_ack_timeout_ms",
  "task_retry_delay_ms",
  "scheduler_interval_ms",
] as const;
const PERCENTS = ["battery_low_pct", "battery_critical_pct", "battery_assign_margin_pct"] as const;
const COUNTS = { unknown_node_alert_count: 1, completed_task_limit: 0, max_task_retries: 0 } as const;

/**
 * Missing keys take their default. A wrong value is an error rather than a
 * silent default: a typo shouldn't quietly change how the farm runs. Unknown
 * keys only warn, so a Pi's config with a since-removed setting still starts.
 */
export function parseConfig(value: unknown): OrchestratorConfig {
  if (!isRecord(value)) throw new Error("config must be a JSON object");
  for (const key of Object.keys(value)) {
    if (!(key in DEFAULTS)) console.warn(`[CONFIG] Ignoring unknown key: ${key}`);
  }
  const config = { ...DEFAULTS, ...value } as OrchestratorConfig;

  for (const key of POSITIVE_MS) {
    if (!isFiniteNumber(config[key]) || config[key] <= 0) {
      throw new Error(`${key} must be a positive number`);
    }
  }
  for (const key of PERCENTS) {
    if (!isFiniteNumber(config[key]) || config[key] < 0 || config[key] > 100) {
      throw new Error(`${key} must be a number from 0 to 100`);
    }
  }
  // The critical alert only fires inside the low band
  if (config.battery_critical_pct > config.battery_low_pct) {
    throw new Error("battery_critical_pct must not be above battery_low_pct");
  }
  for (const [key, min] of Object.entries(COUNTS) as [keyof typeof COUNTS, number][]) {
    if (!Number.isInteger(config[key]) || config[key] < min) {
      throw new Error(`${key} must be a whole number of at least ${min}`);
    }
  }
  if (typeof config.battery_failsafe !== "boolean") {
    throw new Error("battery_failsafe must be true or false");
  }
  // Entries are checked against the topology by validatePlants
  for (const key of ["plant_schedules", "robot_plants"] as const) {
    if (!Array.isArray(config[key])) throw new Error(`${key} must be an array`);
  }
  return config;
}

/** The defaults without a path (tests); throws on an unreadable or bad file */
export function loadConfig(path?: string): OrchestratorConfig {
  if (!path) return { ...DEFAULTS };
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`could not read config ${path}: ${reason}`);
  }
  return parseConfig(value);
}
