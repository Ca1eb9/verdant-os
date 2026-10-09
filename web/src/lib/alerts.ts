import type { FarmIdentity, SensorReading, TelemetryAlert } from "@/lib/types";

const ALERT_STORAGE_PREFIX = "verdantos:alerts:v1:";
const LAST_AGE_WARNING_MS = 10_000;
const LAST_AGE_CRITICAL_MS = 30_000;
const MAX_STORED_ALERTS = 50;
/** A reading must stay out of range this long before it raises (or escalates) an alert */
const HOLD_MS = 30_000;

// deadband: once raised, an alert clears only when the value is back inside its
// limit by this much. About one step of each sensor's noise: the DHT11 reports
// whole degrees and whole percent, so its values otherwise flap across a limit.
const THRESHOLDS = {
  airTemperature: {
    warningMin: 18,
    warningMax: 28,
    criticalMin: 16,
    criticalMax: 30,
    deadband: 1,
    unit: "°C",
  },
  humidity: {
    warningMin: 40,
    warningMax: 70,
    criticalMin: 35,
    criticalMax: 80,
    deadband: 3,
    unit: "%",
  },
  waterTemperature: {
    warningMin: 18,
    warningMax: 24,
    criticalMin: 16,
    criticalMax: 26,
    deadband: 0.3,
    unit: "°C",
  },
  ph: {
    warningMin: 5.5,
    warningMax: 6.8,
    criticalMin: 5.2,
    criticalMax: 7.2,
    deadband: 0.1,
    unit: "pH",
  },
} as const;

type Range = (typeof THRESHOLDS)[keyof typeof THRESHOLDS];
type Band = "ok" | "warningLow" | "warningHigh" | "criticalLow" | "criticalHigh";

const RANK: Record<Band, number> = { ok: 0, warningLow: 1, warningHigh: 1, criticalLow: 2, criticalHigh: 2 };

/**
 * Per farm and metric: the band its alert is raised at, and the band the
 * readings are in now and since when. Kept for the page's lifetime, across pages.
 */
interface MetricState {
  raised: Band;
  candidate: Band;
  since: number;
}
const metricStates = new Map<string, MetricState>();

type StoredAlertState = {
  alerts: TelemetryAlert[];
  activeSignatures: string[];
};

function storageKey(farmId: string) {
  return `${ALERT_STORAGE_PREFIX}${farmId}`;
}

function isClient() {
  return typeof window !== "undefined";
}

function toFixed(value: number, precision = 1) {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  }).format(value);
}

function buildAlertId() {
  return globalThis.crypto?.randomUUID?.() ?? `alert-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function buildAlertSignature(alert: Omit<TelemetryAlert, "id">) {
  return [
    alert.farmId,
    alert.metric,
    alert.severity,
    alert.title,
    alert.threshold ?? "",
  ].join("|");
}

function readStoredState(farmId: string): StoredAlertState {
  if (!isClient()) {
    return { alerts: [], activeSignatures: [] };
  }

  try {
    const value = window.localStorage.getItem(storageKey(farmId));
    if (!value) {
      return { alerts: [], activeSignatures: [] };
    }

    const parsed = JSON.parse(value) as Partial<StoredAlertState>;

    return {
      alerts: Array.isArray(parsed.alerts) ? (parsed.alerts as TelemetryAlert[]) : [],
      activeSignatures: Array.isArray(parsed.activeSignatures)
        ? (parsed.activeSignatures as string[])
        : [],
    };
  } catch {
    return { alerts: [], activeSignatures: [] };
  }
}

function writeStoredState(farmId: string, state: StoredAlertState) {
  if (!isClient()) {
    return;
  }

  window.localStorage.setItem(storageKey(farmId), JSON.stringify(state));
}

function makeAlert(
  farm: FarmIdentity,
  metric: TelemetryAlert["metric"],
  severity: TelemetryAlert["severity"],
  title: string,
  message: string,
  value?: string,
  threshold?: string,
): TelemetryAlert {
  return {
    id: buildAlertId(),
    farmId: farm.id,
    farmName: farm.name,
    metric,
    severity,
    title,
    message,
    detectedAt: new Date().toISOString(),
    value,
    threshold,
  };
}

function bandOf(value: number, range: Range): Band {
  if (value < range.criticalMin) return "criticalLow";
  if (value > range.criticalMax) return "criticalHigh";
  if (value < range.warningMin) return "warningLow";
  if (value > range.warningMax) return "warningHigh";
  return "ok";
}

/** The value's band, except that a raised band holds until the value is past its limit by the deadband */
function bandWithDeadband(value: number, range: Range, raised: Band): Band {
  const band = bandOf(value, range);
  if (raised === "ok" || band === raised) return band;
  const nudged = raised.endsWith("High") ? value + range.deadband : value - range.deadband;
  return bandOf(nudged, range) === raised ? raised : band;
}

/**
 * The band to alert at. Raising or escalating waits until the readings have
 * stayed in the new band for HOLD_MS, so a one-off spike raises nothing;
 * easing or clearing is immediate (the deadband already keeps it steady).
 */
function settle(key: string, band: Band, now: number, holdMs: number): Band {
  const state = metricStates.get(key) ?? { raised: "ok", candidate: "ok", since: now };
  if (band !== state.candidate) {
    state.candidate = band;
    state.since = now;
  }
  if (RANK[band] < RANK[state.raised] || (band !== state.raised && now - state.since >= holdMs)) {
    state.raised = band;
  }
  metricStates.set(key, state);
  return state.raised;
}

function rangeAlert(
  farm: FarmIdentity,
  metric: TelemetryAlert["metric"],
  label: string,
  value: number,
  band: Band,
  range: Range,
) {
  const { unit } = range;
  const reading = `${toFixed(value)} ${unit}`;
  switch (band) {
    case "criticalLow":
      return makeAlert(farm, metric, "critical", `${label} too low`,
        `${label} at ${reading} is below the critical floor.`, reading, `>= ${range.criticalMin} ${unit}`);
    case "criticalHigh":
      return makeAlert(farm, metric, "critical", `${label} too high`,
        `${label} at ${reading} is above the critical ceiling.`, reading, `<= ${range.criticalMax} ${unit}`);
    case "warningLow":
      return makeAlert(farm, metric, "warning", `${label} low`,
        `${label} at ${reading} is below target band.`, reading, `>= ${range.warningMin} ${unit}`);
    case "warningHigh":
      return makeAlert(farm, metric, "warning", `${label} high`,
        `${label} at ${reading} is above target band.`, reading, `<= ${range.warningMax} ${unit}`);
    default:
      return null;
  }
}

/**
 * The farm's environment alerts for its latest reading. `holdMs` is 0 for mock
 * data, whose clock stands still.
 */
export function evaluateTelemetryAlerts(
  farm: FarmIdentity,
  reading: SensorReading,
  lastUpdate: Date,
  now: number,
  holdMs = HOLD_MS,
) {
  const alerts: TelemetryAlert[] = [];
  const ageMs = now - lastUpdate.getTime();

  if (ageMs >= LAST_AGE_CRITICAL_MS) {
    alerts.push(
      makeAlert(
        farm,
        "connection",
        "critical",
        "Ingestion stopped",
        `No sensor heartbeat for ${Math.round(ageMs / 1000)} seconds.`,
        `${Math.round(ageMs / 1000)}s ago`,
        `<= ${Math.floor(LAST_AGE_WARNING_MS / 1000)}s`,
      ),
    );
  } else if (ageMs >= LAST_AGE_WARNING_MS) {
    alerts.push(
      makeAlert(
        farm,
        "connection",
        "warning",
        "Ingestion delayed",
        `Last sensor heartbeat was ${Math.round(ageMs / 1000)} seconds ago.`,
        `${Math.round(ageMs / 1000)}s ago`,
        `<= ${Math.floor(LAST_AGE_WARNING_MS / 1000)}s`,
      ),
    );
  }

  // A sensor that didn't read raises nothing here (the shelf bridge alerts on
  // silence) and keeps its state, so its alert returns as soon as it reads again
  const ranges = [
    ["air.temperature", "Air temperature", reading.airTemperature, THRESHOLDS.airTemperature],
    ["air.humidity", "Humidity", reading.humidity, THRESHOLDS.humidity],
    ["water.temperature", "Water temperature", reading.waterTemperature, THRESHOLDS.waterTemperature],
    ["water.ph", "pH", reading.ph, THRESHOLDS.ph],
  ] as const;

  for (const [metric, label, value, range] of ranges) {
    if (value === null) continue;
    const key = `${farm.id}|${metric}`;
    const raised = metricStates.get(key)?.raised ?? "ok";
    const band = settle(key, bandWithDeadband(value, range, raised), now, holdMs);
    const alert = rangeAlert(farm, metric, label, value, band, range);
    if (alert) alerts.push(alert);
  }

  // The reservoir has a level switch, not a gauge: below it is already critical
  const levelBand: Band = reading.waterLevelOk === false ? "criticalLow" : "ok";
  if (reading.waterLevelOk !== null && settle(`${farm.id}|water.level`, levelBand, now, holdMs) !== "ok") {
    alerts.push(
      makeAlert(
        farm,
        "water.level",
        "critical",
        "Reservoir low",
        "The reservoir is below the level sensor. Refill it.",
        "LOW",
        "OK",
      ),
    );
  }

  return alerts;
}

/**
 * Alerts are re-evaluated every second, each time as new objects. One that was
 * already active keeps its stored id and detection time, so lists don't show
 * it as just detected or reorder it; its value and message stay current.
 */
export function keepFirstDetection(farmId: string, currentAlerts: TelemetryAlert[]) {
  const state = readStoredState(farmId);
  const active = new Set(state.activeSignatures);
  const stored = new Map(state.alerts.map((alert) => [buildAlertSignature(alert), alert]));

  return currentAlerts.map((alert) => {
    const signature = buildAlertSignature(alert);
    const first = active.has(signature) ? stored.get(signature) : undefined;
    return first ? { ...alert, id: first.id, detectedAt: first.detectedAt } : alert;
  });
}

export function recordTelemetryAlerts(
  farmId: string,
  currentAlerts: TelemetryAlert[],
) {
  const state = readStoredState(farmId);
  const nextAlerts = [...state.alerts];
  const activeSignatures = new Set(state.activeSignatures);

  for (const alert of currentAlerts) {
    const signature = buildAlertSignature(alert);

    if (!activeSignatures.has(signature)) {
      nextAlerts.unshift({
        ...alert,
      });
    }
  }

  const nextActiveSignatures = currentAlerts.map(buildAlertSignature);

  const dedupedAlerts: TelemetryAlert[] = [];
  const seen = new Set<string>();

  for (const alert of nextAlerts) {
    const signature = buildAlertSignature(alert);

    if (seen.has(signature)) {
      continue;
    }

    seen.add(signature);
    dedupedAlerts.push(alert);
  }

  writeStoredState(farmId, {
    alerts: dedupedAlerts.slice(0, MAX_STORED_ALERTS),
    activeSignatures: nextActiveSignatures,
  });

  return dedupedAlerts.slice(0, MAX_STORED_ALERTS);
}

export function readTelemetryAlerts(farmId: string) {
  return readStoredState(farmId).alerts;
}
