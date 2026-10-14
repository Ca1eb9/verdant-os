import { randomUUID } from "node:crypto";
import { AlertSeverity, type FarmAlert, type SensorThreshold } from "@farm/shared";

export type AlertSourceType = FarmAlert["source_type"];

export interface Reading {
  source: string;
  sourceType: AlertSourceType;
  values: Record<string, unknown>;
}

export interface RaisedAlert {
  alert: FarmAlert;
  /** True when it repeats an alert already raised at this band, after the cooldown */
  reminder: boolean;
}

type Band = "ok" | "warningLow" | "warningHigh" | "criticalLow" | "criticalHigh";

const RANK: Record<Band, number> = { ok: 0, warningLow: 1, warningHigh: 1, criticalLow: 2, criticalHigh: 2 };

/** The reservoir has a level switch, not a gauge: below it is already critical */
const WATER_LEVEL_METRIC = "water_level_ok";

/**
 * Per device and metric: the band its alert is raised at, the band the
 * readings are in now and since when, and when it last alerted.
 */
interface MetricState {
  raised: Band;
  candidate: Band;
  since: number;
  lastAlertedAt: number;
}

/**
 * Turns readings into alerts. A reading must stay in a worse band for the hold
 * time before it raises or escalates an alert; easing or clearing is immediate,
 * and the deadband keeps a value sitting on a limit from flapping. Times are
 * monotonic ms: the Pi has no RTC, so its wall clock can jump.
 */
export class ThresholdEvaluator {
  private readonly states = new Map<string, MetricState>();

  constructor(
    private readonly thresholds: readonly SensorThreshold[],
    private readonly holdMs: number,
    private readonly cooldownMs: number,
  ) {}

  evaluate(reading: Reading, now: number, timestamp = Date.now()): RaisedAlert[] {
    const raised: RaisedAlert[] = [];

    // A sensor that didn't read (null or absent) raises nothing and keeps its
    // state, so its alert returns as soon as it reads again
    for (const threshold of this.thresholds) {
      const value = reading.values[threshold.metric];
      if (typeof value !== "number" || !Number.isFinite(value)) continue;

      const key = this.key(reading, threshold.metric);
      const prior = this.states.get(key)?.raised ?? "ok";
      const result = this.settle(key, bandWithDeadband(value, threshold, prior), now);
      if (!result) continue;

      const severity = RANK[result.band] === 2 ? AlertSeverity.CRITICAL : AlertSeverity.WARNING;
      const limit = limitOf(result.band, threshold);
      raised.push({
        reminder: result.reminder,
        alert: {
          alert_id: randomUUID(),
          severity,
          source: reading.source,
          source_type: reading.sourceType,
          message: renderMessage(threshold.message_template, {
            source: reading.source,
            value: formatNumber(value),
            limit: String(limit),
            direction: result.band.endsWith("Low") ? "below" : "above",
            severity,
          }),
          metric: threshold.metric,
          value,
          threshold: limit,
          timestamp,
        },
      });
    }

    const level = reading.values[WATER_LEVEL_METRIC];
    if (typeof level === "boolean") {
      const result = this.settle(this.key(reading, WATER_LEVEL_METRIC), level ? "ok" : "criticalLow", now);
      if (result) {
        raised.push({
          reminder: result.reminder,
          alert: {
            alert_id: randomUUID(),
            severity: AlertSeverity.CRITICAL,
            source: reading.source,
            source_type: reading.sourceType,
            message: `${reading.source} reservoir is below the level sensor. Refill it.`,
            metric: WATER_LEVEL_METRIC,
            // FarmAlert carries numbers: 0 is false (low), 1 is true (ok)
            value: 0,
            threshold: 1,
            timestamp,
          },
        });
      }
    }

    return raised;
  }

  private key(reading: Reading, metric: string) {
    return `${reading.sourceType}:${reading.source}:${metric}`;
  }

  /**
   * Moves the metric's raised band towards `band` and says whether to publish:
   * on raising or escalating, and as a reminder once the cooldown has passed
   * while the band holds. Easing to a milder band publishes nothing.
   */
  private settle(key: string, band: Band, now: number): { band: Band; reminder: boolean } | null {
    const state = this.states.get(key) ?? { raised: "ok", candidate: "ok", since: now, lastAlertedAt: 0 };
    this.states.set(key, state);
    if (band !== state.candidate) {
      state.candidate = band;
      state.since = now;
    }

    const prior = state.raised;
    if (RANK[band] < RANK[prior] || (band !== prior && now - state.since >= this.holdMs)) {
      state.raised = band;
    }
    if (state.raised === "ok") return null;

    // A new band at least as bad as the old one: low to high counts as new
    if (state.raised !== prior && RANK[state.raised] >= RANK[prior]) {
      state.lastAlertedAt = now;
      return { band: state.raised, reminder: false };
    }
    if (now - state.lastAlertedAt >= this.cooldownMs) {
      state.lastAlertedAt = now;
      return { band: state.raised, reminder: true };
    }
    return null;
  }
}

function bandOf(value: number, threshold: SensorThreshold): Band {
  if (value < threshold.critical_min) return "criticalLow";
  if (value > threshold.critical_max) return "criticalHigh";
  if (value < threshold.warning_min) return "warningLow";
  if (value > threshold.warning_max) return "warningHigh";
  return "ok";
}

/** The value's band, except that a raised band holds until the value is past its limit by the deadband */
function bandWithDeadband(value: number, threshold: SensorThreshold, raised: Band): Band {
  const band = bandOf(value, threshold);
  if (raised === "ok" || band === raised) return band;
  const nudged = raised.endsWith("High") ? value + threshold.deadband : value - threshold.deadband;
  return bandOf(nudged, threshold) === raised ? raised : band;
}

function limitOf(band: Band, threshold: SensorThreshold): number {
  switch (band) {
    case "criticalLow": return threshold.critical_min;
    case "criticalHigh": return threshold.critical_max;
    case "warningLow": return threshold.warning_min;
    default: return threshold.warning_max;
  }
}

/** At most two decimals: pH is computed from millivolts */
function formatNumber(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function renderMessage(template: string, replacements: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => replacements[key] ?? match);
}
