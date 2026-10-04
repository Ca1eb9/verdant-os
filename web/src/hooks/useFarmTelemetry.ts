"use client";

import { useEffect, useMemo, useState } from "react";
import { useSelectedFarm } from "@/components/farms/FarmContext";
import { evaluateTelemetryAlerts, recordTelemetryAlerts } from "@/lib/alerts";
import { getCalibratedLightPpfd } from "@/lib/light-calibration";
import { MOCK_DATA_ENABLED, buildLiveTelemetry } from "@/lib/mock-data";
import type {
  LiveStatus,
  SensorEventRecord,
  SensorReading,
  TelemetryAlert,
  TelemetrySnapshot,
} from "@/lib/types";

const STALE_AFTER_MS = 10_000;
const POLL_INTERVAL_MS = 2_000;

function storageKey(farmId: string) {
  return `verdantos:v4:last-reading:${farmId}`;
}

function eventToReading(event: SensorEventRecord): SensorReading {
  return {
    timestamp: event.created_at ?? event.ts ?? new Date().toISOString(),
    device: event.device,
    airTemperature: event.air_temp_c,
    humidity: event.humidity_pct,
    // the shelf node has no pressure or EC sensor
    pressure: null,
    waterTemperature: event.water_temp_c,
    ph: event.ph,
    ec: null,
    waterLevelOk: event.water_level_ok,
    waterLevelText: event.water_level_text,
    ppfd: getCalibratedLightPpfd(event.light_lux, event.light_ppfd),
  };
}

function snapshotToReading(snapshot: TelemetrySnapshot): SensorReading {
  return {
    timestamp: snapshot.timestamp,
    device: snapshot.deviceId,
    airTemperature: snapshot.air.temperature,
    humidity: snapshot.air.humidity,
    pressure: snapshot.air.pressure,
    waterTemperature: snapshot.water.temperature,
    ph: snapshot.water.ph,
    ec: snapshot.water.ec,
    waterLevelOk: snapshot.water.levelFloat === 1,
    waterLevelText: snapshot.water.levelText ?? null,
    ppfd: snapshot.light.ppfd,
  };
}

const NUMBER_FIELDS = ["airTemperature", "humidity", "pressure", "waterTemperature", "ph", "ec", "ppfd"] as const;

function isReading(value: unknown): value is SensorReading {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.timestamp === "string" &&
    !Number.isNaN(new Date(r.timestamp).getTime()) &&
    (r.device === null || typeof r.device === "string") &&
    NUMBER_FIELDS.every((key) => r[key] === null || (typeof r[key] === "number" && Number.isFinite(r[key]))) &&
    (r.waterLevelOk === null || typeof r.waterLevelOk === "boolean") &&
    (r.waterLevelText === null || typeof r.waterLevelText === "string")
  );
}

// The last reading per farm, so a reload while the feed is down still shows it (as stale)
function readStoredReading(farmId: string): SensorReading | null {
  try {
    const value = window.localStorage.getItem(storageKey(farmId));
    const parsed: unknown = value ? JSON.parse(value) : null;
    return isReading(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function storeReading(farmId: string, reading: SensorReading) {
  try {
    window.localStorage.setItem(storageKey(farmId), JSON.stringify(reading));
  } catch {
    // the reading just isn't cached
  }
}

interface LatestSensorResponse {
  event: SensorEventRecord | null;
  error?: string;
}

// Keyed by farm, so a switch never shows (or alerts on) the last farm's reading.
// `polled`: the feed has answered since the switch; until then the reading may
// be a cached one, too old to judge.
interface FeedState {
  farmId: string | null;
  reading: SensorReading | null;
  polled: boolean;
}

/**
 * The selected farm's latest environment reading, polled from its newest
 * sensor_events row. Null until the farm has reported one.
 */
export function useFarmTelemetry(farmId: string | null) {
  const { farm } = useSelectedFarm();
  const [feed, setFeed] = useState<FeedState>({ farmId: null, reading: null, polled: false });
  const [isOnline, setIsOnline] = useState(true);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!farmId) {
      setFeed({ farmId, reading: null, polled: false });
    } else if (MOCK_DATA_ENABLED) {
      const frames = buildLiveTelemetry(farmId);
      setFeed({ farmId, reading: snapshotToReading(frames[frames.length - 1]), polled: true });
    } else {
      setFeed({ farmId, reading: readStoredReading(farmId), polled: false });
    }
  }, [farmId]);

  useEffect(() => {
    const syncNetworkState = () => setIsOnline(window.navigator.onLine);
    syncNetworkState();
    window.addEventListener("online", syncNetworkState);
    window.addEventListener("offline", syncNetworkState);
    return () => {
      window.removeEventListener("online", syncNetworkState);
      window.removeEventListener("offline", syncNetworkState);
    };
  }, []);

  useEffect(() => {
    const intervalId = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    if (MOCK_DATA_ENABLED || !farmId || !isOnline) return undefined;

    let isCancelled = false;

    const fetchLatest = async () => {
      try {
        const response = await fetch(`/api/sensor-events/latest?farm_id=${encodeURIComponent(farmId)}`, {
          cache: "no-store",
        });
        const payload = (await response.json()) as LatestSensorResponse;
        if (isCancelled) return;
        if (!payload.event) {
          setFeed((current) => (current.farmId === farmId ? { ...current, polled: true } : current));
          return;
        }

        const next = eventToReading(payload.event);
        setFeed({ farmId, reading: next, polled: true });
        storeReading(farmId, next);
      } catch {
        // keep the last reading; it turns stale
        if (!isCancelled) setFeed((current) => (current.farmId === farmId ? { ...current, polled: true } : current));
      }
    };

    void fetchLatest();
    const intervalId = window.setInterval(fetchLatest, POLL_INTERVAL_MS);

    return () => {
      isCancelled = true;
      window.clearInterval(intervalId);
    };
  }, [farmId, isOnline]);

  const current = feed.farmId === farmId ? feed : null;
  const reading = current?.reading ?? null;
  const polled = current?.polled ?? false;
  const lastUpdate = useMemo(() => (reading ? new Date(reading.timestamp) : null), [reading]);
  // Mock readings are generated, never stale
  const isStale = !MOCK_DATA_ENABLED && lastUpdate !== null && now - lastUpdate.getTime() > STALE_AFTER_MS;
  const liveStatus: LiveStatus = !reading ? "waiting" : isStale ? "stale" : "live";
  const alerts = useMemo<TelemetryAlert[]>(
    () =>
      farm?.id === farmId && polled && reading && lastUpdate
        ? evaluateTelemetryAlerts(farm, reading, lastUpdate, MOCK_DATA_ENABLED ? lastUpdate.getTime() : now)
        : [],
    [farm, farmId, lastUpdate, now, polled, reading],
  );

  useEffect(() => {
    if (farmId) recordTelemetryAlerts(farmId, alerts);
  }, [alerts, farmId]);

  return {
    reading,
    lastUpdate,
    liveStatus,
    alerts,
  };
}
