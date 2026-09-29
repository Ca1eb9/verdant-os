import type { FarmAlert } from "@/lib/farm/types";
import type { FarmIdentity, TelemetryAlert, TelemetrySnapshot } from "@/lib/types";

const LAST_AGE_WARNING_MS = 10_000;
const LAST_AGE_CRITICAL_MS = 30_000;
// Alerts raised in this tab are kept in memory only (gone on reload; the farm's
// own alert store is queried then). Every occurrence is kept, not one per alert
// type, so time windows count correctly; 7 days is the longest window.
const MAX_STORED_ALERTS = 500;
const STORED_ALERT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

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
  ppfd: {
    warningMin: 180,
    warningMax: 550,
    criticalMin: 150,
    criticalMax: 650,
    unit: "PPFD",
  },
  waterLevel: {
    warningMin: 50,
    criticalMin: 25,
    unit: "%",
  },
} as const;

type StoredAlertState = {
  alerts: TelemetryAlert[];
  activeSignatures: string[];
};

function toFixed(value: number, precision = 1) {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  }).format(value);
}

function buildAlertId() {
  return globalThis.crypto?.randomUUID?.() ?? `alert-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function buildAlertSignature(alert: Omit<TelemetryAlert, "id">) {
  return [
    alert.farmId,
    alert.metric,
    alert.severity,
    alert.title,
    alert.threshold ?? "",
  ].join("|");
}

const alertLog = new Map<string, StoredAlertState>();

function readStoredState(farmId: string): StoredAlertState {
  return alertLog.get(farmId) ?? { alerts: [], activeSignatures: [] };
}

function writeStoredState(farmId: string, state: StoredAlertState) {
  alertLog.set(farmId, state);
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
  snapshot: TelemetrySnapshot,
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

  const airTemperatureAlert = outOfRangeAlert(
    farm,
    "air.temperature",
    "Air temperature",
    snapshot.air.temperature,
    THRESHOLDS.airTemperature.warningMin,
    THRESHOLDS.airTemperature.warningMax,
    THRESHOLDS.airTemperature.criticalMin,
    THRESHOLDS.airTemperature.criticalMax,
    THRESHOLDS.airTemperature.unit,
  );

  const humidityAlert = outOfRangeAlert(
    farm,
    "air.humidity",
    "Humidity",
    snapshot.air.humidity,
    THRESHOLDS.humidity.warningMin,
    THRESHOLDS.humidity.warningMax,
    THRESHOLDS.humidity.criticalMin,
    THRESHOLDS.humidity.criticalMax,
    THRESHOLDS.humidity.unit,
  );

  const waterTempAlert = outOfRangeAlert(
    farm,
    "water.temperature",
    "Water temperature",
    snapshot.water.temperature,
    THRESHOLDS.waterTemperature.warningMin,
    THRESHOLDS.waterTemperature.warningMax,
    THRESHOLDS.waterTemperature.criticalMin,
    THRESHOLDS.waterTemperature.criticalMax,
    THRESHOLDS.waterTemperature.unit,
  );

  const phAlert = outOfRangeAlert(
    farm,
    "water.ph",
    "pH",
    snapshot.water.ph,
    THRESHOLDS.ph.warningMin,
    THRESHOLDS.ph.warningMax,
    THRESHOLDS.ph.criticalMin,
    THRESHOLDS.ph.criticalMax,
    THRESHOLDS.ph.unit,
  );

  const ppfdAlert = outOfRangeAlert(
    farm,
    "light.ppfd",
    "PPFD",
    snapshot.light.ppfd,
    THRESHOLDS.ppfd.warningMin,
    THRESHOLDS.ppfd.warningMax,
    THRESHOLDS.ppfd.criticalMin,
    THRESHOLDS.ppfd.criticalMax,
    THRESHOLDS.ppfd.unit,
  );

  const waterLevelAlert =
    snapshot.water.level < THRESHOLDS.waterLevel.criticalMin
      ? makeAlert(
          farm,
          "water.level",
          "critical",
          "Reservoir low",
          `Reservoir level is ${toFixed(snapshot.water.level, 0)}%, below the critical floor.`,
          `${toFixed(snapshot.water.level, 0)}%`,
          `>= ${THRESHOLDS.waterLevel.warningMin}%`,
        )
      : snapshot.water.level < THRESHOLDS.waterLevel.warningMin
        ? makeAlert(
            farm,
            "water.level",
            "warning",
            "Reservoir level falling",
            `Reservoir level is ${toFixed(snapshot.water.level, 0)}%, below target band.`,
            `${toFixed(snapshot.water.level, 0)}%`,
            `>= ${THRESHOLDS.waterLevel.warningMin}%`,
          )
        : null;

  for (const alert of [
    airTemperatureAlert,
    humidityAlert,
    waterTempAlert,
    phAlert,
    ppfdAlert,
    waterLevelAlert,
  ]) {
    if (alert) {
      alerts.push(alert);
    }
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

  // an alert is stored once when it starts; a later recurrence is a new entry
  const oldest = Date.now() - STORED_ALERT_MAX_AGE_MS;
  const keptAlerts = nextAlerts
    .filter((alert) => new Date(alert.detectedAt).getTime() >= oldest)
    .slice(0, MAX_STORED_ALERTS);

  writeStoredState(farmId, {
    alerts: keptAlerts,
    activeSignatures: nextActiveSignatures,
  });

  return keptAlerts;
}

export function readTelemetryAlerts(farmId: string) {
  return readStoredState(farmId).alerts;
}

/** A farm alert (alert engine, via the data source) in the shape the Alerts page shows */
export function fromFarmAlert(alert: FarmAlert, farm: FarmIdentity): TelemetryAlert {
  return {
    id: alert.alert_id,
    farmId: farm.id,
    farmName: farm.name,
    metric: alert.metric,
    source: alert.source,
    severity: alert.severity === "critical" ? "critical" : "warning",
    title: alert.message,
    message: `Raised by ${alert.source_type} ${alert.source}.`,
    detectedAt: new Date(alert.timestamp).toISOString(),
    value: String(alert.value),
    threshold: String(alert.threshold),
  };
}
