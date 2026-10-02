import { randomUUID } from "node:crypto";
import type { FarmAlert, SensorThreshold } from "@farm/shared";

export type AlertSourceType = FarmAlert["source_type"];

export interface Reading {
  source: string;
  sourceType: AlertSourceType;
  values: Record<string, unknown>;
}

interface MetricState {
  lastAlertedAt: number;
}

export class ThresholdEvaluator {
  private readonly activeViolations = new Map<string, MetricState>();

  constructor(
    private readonly thresholds: readonly SensorThreshold[],
    private readonly cooldownMs: number,
  ) {}

  evaluate(reading: Reading, now = Date.now()): FarmAlert[] {
    const alerts: FarmAlert[] = [];

    for (const threshold of this.thresholds) {
      const value = reading.values[threshold.metric];
      if (value === undefined || value === null) continue;
      if (typeof value !== "number" || !Number.isFinite(value)) continue;

      const key = `${reading.sourceType}:${reading.source}:${threshold.metric}`;
      const violatedThreshold = value < threshold.min
        ? threshold.min
        : value > threshold.max
          ? threshold.max
          : null;

      if (violatedThreshold === null) {
        this.activeViolations.delete(key);
        continue;
      }

      const state = this.activeViolations.get(key);
      if (state && now - state.lastAlertedAt < this.cooldownMs) continue;

      alerts.push({
        alert_id: randomUUID(),
        severity: threshold.severity,
        source: reading.source,
        source_type: reading.sourceType,
        message: renderMessage(threshold.message_template, reading.source, value, threshold),
        metric: threshold.metric,
        value,
        threshold: violatedThreshold,
        timestamp: now,
      });
      this.activeViolations.set(key, { lastAlertedAt: now });
    }

    return alerts;
  }
}

function renderMessage(
  template: string,
  source: string,
  value: number,
  threshold: SensorThreshold,
): string {
  const replacements: Record<string, string> = {
    source,
    metric: threshold.metric,
    value: String(value),
    min: String(threshold.min),
    max: String(threshold.max),
  };
  return template.replace(/\{(source|metric|value|min|max)\}/g, (_, key: string) => replacements[key]);
}
