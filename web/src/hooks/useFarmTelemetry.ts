"use client";

import { useEffect, useMemo, useState } from "react";
import { getFarmDataSource, onFarmDataSourceChange, type ShelfReading } from "@/lib/farm/data-source";
import { MOCK_DATA_ENABLED, buildLiveTelemetry } from "@/lib/mock-data";
import { readingStorageKey } from "@/lib/stored-readings";
import type {
  LiveStatus,
  SensorEventRecord,
  SensorReading,
  TelemetrySnapshot,
} from "@/lib/types";

const STALE_AFTER_MS = 10_000;
const POLL_INTERVAL_MS = 2_000;

function eventToReading(event: SensorEventRecord): SensorReading {
  return {
    timestamp: event.created_at ?? event.ts ?? new Date().toISOString(),
    device: event.device,
    airTemperature: event.air_temp_c,
    humidity: event.humidity_pct,
    waterTemperature: event.water_temp_c,
    ph: event.ph,
    waterLevelOk: event.water_level_ok,
    lightLux: event.light_lux,
  };
}

function shelfToReading({ data, receivedAt }: ShelfReading): SensorReading {
  return {
    // the browser's receive time, so staleness never depends on the Pi's clock
    timestamp: new Date(receivedAt).toISOString(),
    device: data.shelf_id,
    airTemperature: data.temperature_c,
    humidity: data.humidity_pct,
    waterTemperature: data.water_temp_c,
    ph: data.ph,
    waterLevelOk: data.water_level_ok,
    lightLux: data.light_lux,
  };
}

function snapshotToReading(snapshot: TelemetrySnapshot): SensorReading {
  return {
    timestamp: snapshot.timestamp,
    device: snapshot.deviceId,
    airTemperature: snapshot.air.temperature,
    humidity: snapshot.air.humidity,
    waterTemperature: snapshot.water.temperature,
    ph: snapshot.water.ph,
    waterLevelOk: snapshot.water.levelFloat === 1,
    lightLux: snapshot.light.lux,
  };
}

const NUMBER_FIELDS = ["airTemperature", "humidity", "waterTemperature", "ph", "lightLux"] as const;

function isReading(value: unknown): value is SensorReading {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.timestamp === "string" &&
    !Number.isNaN(new Date(r.timestamp).getTime()) &&
    (r.device === null || typeof r.device === "string") &&
    NUMBER_FIELDS.every((key) => r[key] === null || (typeof r[key] === "number" && Number.isFinite(r[key]))) &&
    (r.waterLevelOk === null || typeof r.waterLevelOk === "boolean")
  );
}

// The last reading per farm, so a reload while the feed is down still shows it (as stale)
function readStoredReading(farmId: string): SensorReading | null {
  try {
    const value = window.localStorage.getItem(readingStorageKey(farmId));
    const parsed: unknown = value ? JSON.parse(value) : null;
    return isReading(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function storeReading(farmId: string, reading: SensorReading) {
  try {
    window.localStorage.setItem(readingStorageKey(farmId), JSON.stringify(reading));
  } catch {
    // the reading just isn't cached
  }
}

interface LatestSensorResponse {
  event: SensorEventRecord | null;
  error?: string;
}

// Keyed by farm, so a switch never shows the last farm's reading
interface FeedState {
  farmId: string | null;
  reading: SensorReading | null;
}

/**
 * The selected farm's latest environment reading: streamed from the data
 * source when it has a shelf feed (FarmNet: the newest reading of any shelf),
 * otherwise polled from the farm's newest sensor_events row. Null until the
 * farm has reported one.
 */
export function useFarmTelemetry(farmId: string | null) {
  const [feed, setFeed] = useState<FeedState>({ farmId: null, reading: null });
  const [source, setSource] = useState(getFarmDataSource);
  /** Whether the source streams shelf readings; null until it has said */
  const [hasShelfFeed, setHasShelfFeed] = useState<boolean | null>(null);
  const [isOnline, setIsOnline] = useState(true);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!farmId) {
      setFeed({ farmId, reading: null });
    } else if (MOCK_DATA_ENABLED) {
      const frames = buildLiveTelemetry(farmId);
      setFeed({ farmId, reading: snapshotToReading(frames[frames.length - 1]) });
    } else {
      setFeed({ farmId, reading: readStoredReading(farmId) });
    }
  }, [farmId]);

  useEffect(() => onFarmDataSourceChange(() => setSource(getFarmDataSource())), []);

  useEffect(() => {
    if (MOCK_DATA_ENABLED || !farmId) return undefined;
    return source.subscribeShelves((shelves) => {
      setHasShelfFeed(shelves !== null);
      if (!shelves) return;
      const newest = shelves.reduce<ShelfReading | null>(
        (latest, shelf) => (!latest || shelf.receivedAt > latest.receivedAt ? shelf : latest),
        null,
      );
      if (!newest) {
        setFeed((current) => (current.farmId === farmId ? { ...current } : current));
        return;
      }
      const next = shelfToReading(newest);
      setFeed({ farmId, reading: next });
      storeReading(farmId, next);
    });
  }, [source, farmId]);

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
    if (MOCK_DATA_ENABLED || !farmId || !isOnline || hasShelfFeed !== false) return undefined;

    let isCancelled = false;

    const fetchLatest = async () => {
      try {
        const response = await fetch(`/api/sensor-events/latest?farm_id=${encodeURIComponent(farmId)}`, {
          cache: "no-store",
        });
        const payload = (await response.json()) as LatestSensorResponse;
        if (isCancelled) return;
        if (!payload.event) {
          setFeed((current) => (current.farmId === farmId ? { ...current } : current));
          return;
        }

        const next = eventToReading(payload.event);
        setFeed({ farmId, reading: next });
        storeReading(farmId, next);
      } catch {
        // keep the last reading; it turns stale
        if (!isCancelled) setFeed((current) => (current.farmId === farmId ? { ...current } : current));
      }
    };

    void fetchLatest();
    const intervalId = window.setInterval(fetchLatest, POLL_INTERVAL_MS);

    return () => {
      isCancelled = true;
      window.clearInterval(intervalId);
    };
  }, [farmId, isOnline, hasShelfFeed]);

  const current = feed.farmId === farmId ? feed : null;
  const reading = current?.reading ?? null;
  const lastUpdate = useMemo(() => (reading ? new Date(reading.timestamp) : null), [reading]);
  // Mock readings are generated, never stale
  const isStale = !MOCK_DATA_ENABLED && lastUpdate !== null && now - lastUpdate.getTime() > STALE_AFTER_MS;
  const liveStatus: LiveStatus = !reading ? "waiting" : isStale ? "stale" : "live";

  return {
    reading,
    lastUpdate,
    liveStatus,
  };
}
