import { readFileSync } from "node:fs";
import { AlertSeverity, type SensorThreshold } from "@farm/shared";

export interface AlertEngineConfig {
  cooldown_ms: number;
  thresholds: SensorThreshold[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseThreshold(value: unknown, index: number): SensorThreshold {
  if (!isRecord(value)) {
    throw new Error(`thresholds[${index}] must be an object`);
  }

  const { metric, min, max, severity, message_template: template } = value;
  if (typeof metric !== "string" || metric.trim() === "") {
    throw new Error(`thresholds[${index}].metric must be a non-empty string`);
  }
  if (typeof min !== "number" || !Number.isFinite(min)) {
    throw new Error(`thresholds[${index}].min must be a finite number`);
  }
  if (typeof max !== "number" || !Number.isFinite(max)) {
    throw new Error(`thresholds[${index}].max must be a finite number`);
  }
  if (min > max) {
    throw new Error(`thresholds[${index}].min cannot exceed max`);
  }
  if (!Object.values(AlertSeverity).includes(severity as AlertSeverity)) {
    throw new Error(`thresholds[${index}].severity is invalid`);
  }
  if (typeof template !== "string" || template.trim() === "") {
    throw new Error(`thresholds[${index}].message_template must be a non-empty string`);
  }

  return { metric, min, max, severity: severity as AlertSeverity, message_template: template };
}

export function parseConfig(value: unknown): AlertEngineConfig {
  if (!isRecord(value)) throw new Error("config must be a JSON object");
  if (typeof value.cooldown_ms !== "number" || !Number.isFinite(value.cooldown_ms) || value.cooldown_ms < 0) {
    throw new Error("cooldown_ms must be a non-negative finite number");
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

  return { cooldown_ms: value.cooldown_ms, thresholds };
}

export function loadConfig(path: string): AlertEngineConfig {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`could not read config ${path}: ${reason}`);
  }
  return parseConfig(value);
}
