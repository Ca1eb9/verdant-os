import { readFileSync } from "node:fs";
import type { AlertConfig, SensorThreshold } from "@farm/shared";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

const LIMITS = ["critical_min", "warning_min", "warning_max", "critical_max"] as const;
const TEMPLATES = ["message_template", "resolved_template"] as const;

function parseThreshold(value: unknown, index: number): SensorThreshold {
  if (!isRecord(value)) {
    throw new Error(`thresholds[${index}] must be an object`);
  }

  const { metric, deadband } = value;
  if (typeof metric !== "string" || metric.trim() === "") {
    throw new Error(`thresholds[${index}].metric must be a non-empty string`);
  }
  for (const key of LIMITS) {
    if (!isFiniteNumber(value[key])) {
      throw new Error(`thresholds[${index}].${key} must be a finite number`);
    }
  }
  const [criticalMin, warningMin, warningMax, criticalMax] = LIMITS.map((key) => value[key] as number);
  // The warning band sits inside the critical one
  if (!(criticalMin <= warningMin && warningMin < warningMax && warningMax <= criticalMax)) {
    throw new Error(`thresholds[${index}] must have critical_min <= warning_min < warning_max <= critical_max`);
  }
  if (!isFiniteNumber(deadband) || deadband < 0) {
    throw new Error(`thresholds[${index}].deadband must be a non-negative finite number`);
  }
  for (const key of TEMPLATES) {
    if (typeof value[key] !== "string" || (value[key] as string).trim() === "") {
      throw new Error(`thresholds[${index}].${key} must be a non-empty string`);
    }
  }

  return {
    metric,
    warning_min: warningMin,
    warning_max: warningMax,
    critical_min: criticalMin,
    critical_max: criticalMax,
    deadband,
    message_template: value.message_template as string,
    resolved_template: value.resolved_template as string,
  };
}

export function parseConfig(value: unknown): AlertConfig {
  if (!isRecord(value)) throw new Error("config must be a JSON object");
  for (const key of ["hold_ms", "cooldown_ms"]) {
    if (!isFiniteNumber(value[key]) || (value[key] as number) < 0) {
      throw new Error(`${key} must be a non-negative finite number`);
    }
  }
  if (!Array.isArray(value.thresholds) || value.thresholds.length === 0) {
    throw new Error("thresholds must be a non-empty array");
  }

  const thresholds = value.thresholds.map(parseThreshold);
  const metrics = new Set<string>();
  for (const threshold of thresholds) {
    if (metrics.has(threshold.metric)) {
      throw new Error(`duplicate threshold metric: ${threshold.metric}`);
    }
    metrics.add(threshold.metric);
  }

  return { hold_ms: value.hold_ms as number, cooldown_ms: value.cooldown_ms as number, thresholds };
}

export function loadConfig(path: string): AlertConfig {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`could not read config ${path}: ${reason}`);
  }
  return parseConfig(value);
}
