"use client";

import { startTransition, useEffect, useMemo, useState } from "react";
import { evaluateTelemetryAlerts, recordTelemetryAlerts } from "@/lib/alerts";
import { getFarmById } from "@/lib/mock-data";
import { getCalibratedLightPpfd } from "@/lib/light-calibration";
import { buildLiveTelemetry } from "@/lib/mock-data";
import type {
  LiveStatus,
  SensorEventRecord,
  TelemetryAlert,
  TelemetrySnapshot,
} from "@/lib/types";

const STALE_AFTER_MS = 10_000;
const POLL_INTERVAL_MS = 2_000;

function storageKey(farmId: string) {
  return `verdantos:v3:last-snapshot:${farmId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function toStringValue(value: unknown, fallback: string) {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function normalizeSnapshot(
  farmId: string,
  storedValue: unknown,
  fallback: TelemetrySnapshot,
): TelemetrySnapshot {
  if (!isRecord(storedValue)) {
    return fallback;
  }

  const air = isRecord(storedValue.air) ? storedValue.air : {};
  const water = isRecord(storedValue.water) ? storedValue.water : {};
  const light = isRecord(storedValue.light) ? storedValue.light : {};
  const rawEvent = isRecord(storedValue.rawEvent) ? storedValue.rawEvent : {};
  const rawAir = isRecord(rawEvent.air) ? rawEvent.air : {};
  const rawWater = isRecord(rawEvent.water) ? rawEvent.water : {};
  const rawLight = isRecord(rawEvent.light) ? rawEvent.light : {};
  const rawLevel = isRecord(rawEvent.level) ? rawEvent.level : {};
  const timestamp = toStringValue(storedValue.timestamp, fallback.timestamp);
  const deviceId = toStringValue(storedValue.deviceId, fallback.deviceId);
  const sequence = toNumber(storedValue.sequence, fallback.sequence);
  const levelFloat =
    water.levelFloat === 0 || water.levelFloat === 1 ? water.levelFloat : fallback.water.levelFloat;

  return {
    farmId,
    deviceId,
    sequence,
    timestamp,
    connectionState: storedValue.connectionState === "offline" ? "offline" : "online",
    rawEvent: {
      type: "sensor",
      ts: toStringValue(rawEvent.ts, timestamp),
      device: toStringValue(rawEvent.device, deviceId),
      seq: toNumber(rawEvent.seq, sequence),
      air: {
        t_c: toNumber(rawAir.t_c, toNumber(air.temperature, fallback.air.temperature)),
        rh_pct: toNumber(rawAir.rh_pct, toNumber(air.humidity, fallback.air.humidity)),
        p_hpa: toNumber(rawAir.p_hpa, toNumber(air.pressure, fallback.air.pressure)),
      },
      water: {
        t_c: toNumber(rawWater.t_c, toNumber(water.temperature, fallback.water.temperature)),
        ph: toNumber(rawWater.ph, toNumber(water.ph, fallback.water.ph)),
        ec_ms_cm: toNumber(rawWater.ec_ms_cm, toNumber(water.ec, fallback.water.ec)),
      },
      light: {
        lux: toNumber(rawLight.lux, toNumber(light.lux, fallback.light.lux)),
        ppfd: toNumber(rawLight.ppfd, toNumber(light.ppfd, fallback.light.ppfd)),
      },
      level: {
        float: rawLevel.float === 0 || rawLevel.float === 1 ? rawLevel.float : levelFloat,
      },
    },
    air: {
      temperature: toNumber(air.temperature, fallback.air.temperature),
      humidity: toNumber(air.humidity, fallback.air.humidity),
      pressure: toNumber(air.pressure, fallback.air.pressure),
    },
    water: {
      temperature: toNumber(water.temperature, fallback.water.temperature),
      ph: toNumber(water.ph, fallback.water.ph),
      ec: toNumber(water.ec, fallback.water.ec),
      level: toNumber(water.level, fallback.water.level),
      levelFloat,
      levelText: toStringValue(water.levelText, fallback.water.levelText ?? ""),
    },
    light: {
      lux: toNumber(light.lux, fallback.light.lux),
      ppfd: toNumber(light.ppfd, fallback.light.ppfd),
    },
  };
}

function valueOrFallback(value: number | null, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function mapSensorEventToSnapshot(
  farmId: string,
  event: SensorEventRecord,
  fallback: TelemetrySnapshot,
): TelemetrySnapshot {
  const timestamp = event.ts ?? event.created_at ?? new Date().toISOString();
  const waterLevelFloat =
    event.water_level_ok === null ? fallback.water.levelFloat : event.water_level_ok ? 1 : 0;
  const waterLevel =
    event.water_level_ok === null ? fallback.water.level : event.water_level_ok ? 72 : 18;
  const lightLux = valueOrFallback(event.light_lux, fallback.light.lux);
  const lightPpfd = getCalibratedLightPpfd(lightLux, event.light_ppfd) ?? fallback.light.ppfd;

  return {
    farmId,
    deviceId: event.device ?? fallback.deviceId,
    sequence: fallback.sequence + 1,
    timestamp,
    connectionState: "online",
    rawEvent: {
      type: "sensor",
      ts: timestamp,
      device: event.device ?? fallback.deviceId,
      seq: fallback.sequence + 1,
      air: {
        t_c: valueOrFallback(event.air_temp_c, fallback.air.temperature),
        rh_pct: valueOrFallback(event.humidity_pct, fallback.air.humidity),
        p_hpa: fallback.air.pressure,
      },
      water: {
        t_c: valueOrFallback(event.water_temp_c, fallback.water.temperature),
        ph: valueOrFallback(event.ph, fallback.water.ph),
        ec_ms_cm: fallback.water.ec,
      },
      light: {
        lux: lightLux,
        ppfd: lightPpfd,
      },
      level: {
        float: waterLevelFloat,
      },
    },
    air: {
      temperature: valueOrFallback(event.air_temp_c, fallback.air.temperature),
      humidity: valueOrFallback(event.humidity_pct, fallback.air.humidity),
      pressure: fallback.air.pressure,
    },
    water: {
      temperature: valueOrFallback(event.water_temp_c, fallback.water.temperature),
      ph: valueOrFallback(event.ph, fallback.water.ph),
      ec: fallback.water.ec,
      level: waterLevel,
      levelFloat: waterLevelFloat,
      levelText: event.water_level_text ?? fallback.water.levelText,
    },
    light: {
      lux: lightLux,
      ppfd: lightPpfd,
    },
  };
}

interface LatestSensorResponse {
  event: SensorEventRecord | null;
  error?: string;
}

function readStoredSnapshot(farmId: string, fallback: TelemetrySnapshot): TelemetrySnapshot | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const value = window.localStorage.getItem(storageKey(farmId));
    return value ? normalizeSnapshot(farmId, JSON.parse(value), fallback) : null;
  } catch {
    return null;
  }
}

function storeSnapshot(farmId: string, snapshot: TelemetrySnapshot) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(storageKey(farmId), JSON.stringify(snapshot));
}

export function useFarmTelemetry(farmId: string) {
  const farm = useMemo(() => getFarmById(farmId), [farmId]);
  const sequence = useMemo(() => buildLiveTelemetry(farmId), [farmId]);
  const latest = sequence[sequence.length - 1];
  const [snapshot, setSnapshot] = useState<TelemetrySnapshot>(latest);
  const [lastUpdate, setLastUpdate] = useState<Date>(new Date(latest.timestamp));
  const [isOnline, setIsOnline] = useState(true);
  const [latestEvent, setLatestEvent] = useState<SensorEventRecord | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const stored = readStoredSnapshot(farmId, latest);
    const nextSnapshot = stored ?? latest;

    setSnapshot(nextSnapshot);
    setLastUpdate(new Date(nextSnapshot.timestamp));
  }, [farmId, latest]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }

    const syncNetworkState = () => {
      setIsOnline(window.navigator.onLine);
    };

    syncNetworkState();

    window.addEventListener("online", syncNetworkState);
    window.addEventListener("offline", syncNetworkState);

    return () => {
      window.removeEventListener("online", syncNetworkState);
      window.removeEventListener("offline", syncNetworkState);
    };
  }, []);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !isOnline) {
      return undefined;
    }

    let isCancelled = false;

    const fetchLatest = async () => {
      try {
        const response = await fetch("/api/sensor-events/latest", {
          cache: "no-store",
        });
        const payload = (await response.json()) as LatestSensorResponse;

        if (isCancelled || !payload.event) {
          return;
        }

        setLatestEvent(payload.event);

        const nextSnapshot = mapSensorEventToSnapshot(farmId, payload.event, latest);
        const heartbeatTime = payload.event.created_at ?? payload.event.ts ?? nextSnapshot.timestamp;
        const updateTime = new Date(heartbeatTime);

        startTransition(() => {
          setSnapshot(nextSnapshot);
        });

        setLastUpdate(Number.isNaN(updateTime.getTime()) ? new Date() : updateTime);
        storeSnapshot(farmId, nextSnapshot);
      } catch {
        return;
      }
    };

    void fetchLatest();
    const intervalId = window.setInterval(fetchLatest, POLL_INTERVAL_MS);

    return () => {
      isCancelled = true;
      window.clearInterval(intervalId);
    };
  }, [farmId, isOnline, latest]);

  const isStale = now - lastUpdate.getTime() > STALE_AFTER_MS;
  const liveStatus: LiveStatus = !isStale ? "live" : "stale";
  const alerts = useMemo<TelemetryAlert[]>(
    () => evaluateTelemetryAlerts(farm, snapshot, lastUpdate, now),
    [farm, lastUpdate, now, snapshot],
  );

  useEffect(() => {
    recordTelemetryAlerts(farmId, alerts);
  }, [alerts, farmId]);

  return {
    snapshot,
    lastUpdate,
    isOnline,
    liveStatus,
    latestEvent,
    isStale,
    alerts,
  };
}
