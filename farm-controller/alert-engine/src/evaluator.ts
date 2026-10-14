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
 * readings are in now and since when, and its last alert and when.
 */
interface MetricState {
  raised: Band;
  candidate: Band;
  since: number;
  lastAlertedAt: number;
  lastAlertId: string | null;
}

/**
 * What to publish for a metric: a raise (new or escalated band), a reminder,
 * an ease to a milder band or a clear back to ok. The last two resolve
 * `resolves`, the metric's previous alert.
 */
interface Outcome {
  kind: "raise" | "reminder" | "ease" | "clear";
  band: Band;
  /** The band before this outcome, whose limit a clear reports */
  prior: Band;
  resolves: string | null;
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
      const outcome = this.settle(key, bandWithDeadband(value, threshold, prior), now);
      if (!outcome) continue;

      const base = { source: reading.source, source_type: reading.sourceType, metric: threshold.metric, value, timestamp };
      if (outcome.kind === "clear") {
        raised.push(this.publish(key, outcome, {
          ...base,
          severity: AlertSeverity.INFO,
          message: renderMessage(threshold.resolved_template, { source: reading.source, value: formatNumber(value) }),
          threshold: limitOf(outcome.prior, threshold),
        }));
        continue;
      }

      const severity = RANK[outcome.band] === 2 ? AlertSeverity.CRITICAL : AlertSeverity.WARNING;
      const limit = limitOf(outcome.band, threshold);
      raised.push(this.publish(key, outcome, {
        ...base,
        severity,
        message: renderMessage(threshold.message_template, {
          source: reading.source,
          value: formatNumber(value),
          limit: String(limit),
          direction: outcome.band.endsWith("Low") ? "below" : "above",
          severity,
        }),
        threshold: limit,
      }));
    }

    const level = reading.values[WATER_LEVEL_METRIC];
    if (typeof level === "boolean") {
      const key = this.key(reading, WATER_LEVEL_METRIC);
      const outcome = this.settle(key, level ? "ok" : "criticalLow", now);
      if (outcome) {
        const cleared = outcome.kind === "clear";
        raised.push(this.publish(key, outcome, {
          severity: cleared ? AlertSeverity.INFO : AlertSeverity.CRITICAL,
          source: reading.source,
          source_type: reading.sourceType,
          message: cleared
            ? `${reading.source} reservoir is back above the level sensor`
            : `${reading.source} reservoir is below the level sensor. Refill it.`,
          metric: WATER_LEVEL_METRIC,
          // FarmAlert carries numbers: 0 is false (low), 1 is true (ok)
          value: cleared ? 1 : 0,
          threshold: 1,
          timestamp,
        }));
      }
    }

    return raised;
  }

  private key(reading: Reading, metric: string) {
    return `${reading.sourceType}:${reading.source}:${metric}`;
  }

  /** Builds the alert and remembers it as the metric's last, for the next ease or clear to resolve */
  private publish(key: string, outcome: Outcome, fields: Omit<FarmAlert, "alert_id" | "resolves">): RaisedAlert {
    const alert: FarmAlert = { alert_id: randomUUID(), ...fields, resolves: outcome.resolves };
    const state = this.states.get(key);
    if (state) state.lastAlertId = outcome.kind === "clear" ? null : alert.alert_id;
    return { alert, reminder: outcome.kind === "reminder" };
  }

  /**
   * Moves the metric's raised band towards `band` and says what to publish:
   * on raising or escalating, as a reminder once the cooldown has passed
   * while the band holds, and on easing or clearing, resolving the last alert.
   */
  private settle(key: string, band: Band, now: number): Outcome | null {
    const state = this.states.get(key)
      ?? { raised: "ok", candidate: "ok", since: now, lastAlertedAt: 0, lastAlertId: null };
    this.states.set(key, state);
    if (band !== state.candidate) {
      state.candidate = band;
      state.since = now;
    }

    const prior = state.raised;
    if (RANK[band] < RANK[prior] || (band !== prior && now - state.since >= this.holdMs)) {
      state.raised = band;
    }
    const outcome = (kind: Outcome["kind"], resolves: string | null = null): Outcome => {
      state.lastAlertedAt = now;
      return { kind, band: state.raised, prior, resolves };
    };

    if (state.raised === "ok") return prior === "ok" ? null : outcome("clear", state.lastAlertId);
    if (RANK[state.raised] < RANK[prior]) return outcome("ease", state.lastAlertId);
    // A new band at least as bad as the old one: low to high counts as new
    if (state.raised !== prior) return outcome("raise");
    if (now - state.lastAlertedAt >= this.cooldownMs) return outcome("reminder");
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
