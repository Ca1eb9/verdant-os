import type { FarmIdentity, SensorReading, TelemetryAlert } from "@/lib/types";

const ALERT_STORAGE_PREFIX = "verdantos:alerts:v1:";
const LAST_AGE_WARNING_MS = 10_000;
const LAST_AGE_CRITICAL_MS = 30_000;
const MAX_STORED_ALERTS = 50;

const THRESHOLDS = {
  airTemperature: {
    warningMin: 18,
    warningMax: 28,
    criticalMin: 16,
    criticalMax: 30,
    unit: "°C",
  },
  humidity: {
    warningMin: 40,
    warningMax: 70,
    criticalMin: 35,
    criticalMax: 80,
    unit: "%",
  },
  waterTemperature: {
    warningMin: 18,
    warningMax: 24,
    criticalMin: 16,
    criticalMax: 26,
    unit: "°C",
  },
  ph: {
    warningMin: 5.5,
    warningMax: 6.8,
    criticalMin: 5.2,
    criticalMax: 7.2,
    unit: "pH",
  },
} as const;

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

function outOfRangeAlert(
  farm: FarmIdentity,
  metric: TelemetryAlert["metric"],
  label: string,
  value: number,
  warningMin: number,
  warningMax: number,
  criticalMin: number,
  criticalMax: number,
  unit: string,
) {
  if (value < criticalMin) {
    return makeAlert(
      farm,
      metric,
      "critical",
      `${label} too low`,
      `${label} at ${toFixed(value)} ${unit} is below the critical floor.`,
      `${toFixed(value)} ${unit}`,
      `>= ${criticalMin} ${unit}`,
    );
  }

  if (value > criticalMax) {
    return makeAlert(
      farm,
      metric,
      "critical",
      `${label} too high`,
      `${label} at ${toFixed(value)} ${unit} is above the critical ceiling.`,
      `${toFixed(value)} ${unit}`,
      `<= ${criticalMax} ${unit}`,
    );
  }

  if (value < warningMin) {
    return makeAlert(
      farm,
      metric,
      "warning",
      `${label} low`,
      `${label} at ${toFixed(value)} ${unit} is below target band.`,
      `${toFixed(value)} ${unit}`,
      `>= ${warningMin} ${unit}`,
    );
  }

  if (value > warningMax) {
    return makeAlert(
      farm,
      metric,
      "warning",
      `${label} high`,
      `${label} at ${toFixed(value)} ${unit} is above target band.`,
      `${toFixed(value)} ${unit}`,
      `<= ${warningMax} ${unit}`,
    );
  }

  return null;
}

export function evaluateTelemetryAlerts(
  farm: FarmIdentity,
  reading: SensorReading,
  lastUpdate: Date,
  now: number,
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

  // A sensor that didn't read raises nothing here; the shelf bridge alerts on silence
  const ranges = [
    ["air.temperature", "Air temperature", reading.airTemperature, THRESHOLDS.airTemperature],
    ["air.humidity", "Humidity", reading.humidity, THRESHOLDS.humidity],
    ["water.temperature", "Water temperature", reading.waterTemperature, THRESHOLDS.waterTemperature],
    ["water.ph", "pH", reading.ph, THRESHOLDS.ph],
  ] as const;

  for (const [metric, label, value, band] of ranges) {
    if (value === null) continue;
    const alert = outOfRangeAlert(
      farm,
      metric,
      label,
      value,
      band.warningMin,
      band.warningMax,
      band.criticalMin,
      band.criticalMax,
      band.unit,
    );
    if (alert) alerts.push(alert);
  }

  // The reservoir has a level switch, not a gauge: below it is already critical
  if (reading.waterLevelOk === false) {
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
