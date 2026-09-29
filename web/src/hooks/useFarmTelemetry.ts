"use client";

import { startTransition, useEffect, useMemo, useState } from "react";
import { getCalibratedLightPpfd } from "@/lib/light-calibration";
import { buildLiveTelemetry } from "@/lib/mock-data";
import type {
  LiveStatus,
  SensorEventRecord,
  TelemetrySnapshot,
} from "@/lib/types";

/** Shelf sensor feed counts as silent after this long without a reading */
export const SENSOR_STALE_MS = 10_000;
const POLL_INTERVAL_MS = 2_000;

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

export function useFarmTelemetry(farmId: string) {
  const sequence = useMemo(() => buildLiveTelemetry(farmId), [farmId]);
  const latest = sequence[sequence.length - 1];
  const [snapshot, setSnapshot] = useState<TelemetrySnapshot>(latest);
  const [lastUpdate, setLastUpdate] = useState<Date>(new Date(latest.timestamp));
  const [isOnline, setIsOnline] = useState(true);
  const [latestEvent, setLatestEvent] = useState<SensorEventRecord | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // placeholder until the first reading from the database arrives
  useEffect(() => {
    setSnapshot(latest);
    setLastUpdate(new Date(latest.timestamp));
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

  const isStale = now - lastUpdate.getTime() > SENSOR_STALE_MS;
  const liveStatus: LiveStatus = !isStale ? "live" : "stale";
  return {
    snapshot,
    lastUpdate,
    isOnline,
    liveStatus,
    latestEvent,
    isStale,
  };
}
