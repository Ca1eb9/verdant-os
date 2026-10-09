"use client";

import { useEffect, useMemo, useState } from "react";
import { getFarmDataSource, onFarmDataSourceChange, type ShelfReading } from "@/lib/farm/data-source";
import type { HistoryPoint, HistoryRange } from "@/lib/types";

const MINUTE_MS = 60_000;
const RANGE_MS: Record<HistoryRange, number> = { "24h": 24 * 60 * MINUTE_MS, "72h": 72 * 60 * MINUTE_MS, "7d": 7 * 24 * 60 * MINUTE_MS };
/** Bucket sizes to pick from: the smallest that keeps a chart under MAX_POINTS */
const BUCKET_STEPS_MS = [5_000, 15_000, 30_000, MINUTE_MS, 5 * MINUTE_MS, 15 * MINUTE_MS, 30 * MINUTE_MS, 60 * MINUTE_MS];
const MAX_POINTS = 300;

function mean(readings: ShelfReading[], read: (r: ShelfReading) => number | null) {
  const values = readings.map(read).filter((v): v is number => v !== null);
  return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null;
}

/**
 * Averages the readings in each time bucket of the range. Buckets are sized to
 * the readings there are, not to the whole range, so a few minutes since the
 * page opened still draw a line. Every shelf counts
 * towards the farm's line, as on the dashboard; times are the browser's
 * receive times (there's no clock sync with the Pi).
 */
function toPoints(readings: ShelfReading[], range: HistoryRange, now: number): HistoryPoint[] {
  const from = now - RANGE_MS[range];
  const inRange = readings.filter((reading) => reading.receivedAt >= from);
  if (!inRange.length) return [];
  const span = now - inRange[0].receivedAt;
  const size = BUCKET_STEPS_MS.find((step) => span / step <= MAX_POINTS) ?? BUCKET_STEPS_MS[BUCKET_STEPS_MS.length - 1];
  const buckets = new Map<number, ShelfReading[]>();
  for (const reading of inRange) {
    const start = Math.floor(reading.receivedAt / size) * size;
    const bucket = buckets.get(start);
    if (bucket) bucket.push(reading);
    else buckets.set(start, [reading]);
  }
  return [...buckets].map(([start, inBucket]) => ({
    timestamp: new Date(start).toISOString(),
    air: { temperature: mean(inBucket, (r) => r.data.temperature_c), humidity: mean(inBucket, (r) => r.data.humidity_pct) },
    water: { temperature: mean(inBucket, (r) => r.data.water_temp_c), ph: mean(inBucket, (r) => r.data.ph) },
    light: { lux: mean(inBucket, (r) => r.data.light_lux) },
  }));
}

/**
 * Chart points from the shelf readings the data source has received since the
 * dashboard opened. `live` is false when the source has no live shelf feed
 * (remote, for now), and the points are then empty.
 */
export function useShelfHistory(range: HistoryRange) {
  const [source, setSource] = useState(getFarmDataSource);
  const [readings, setReadings] = useState<ShelfReading[] | null>(null);

  useEffect(() => onFarmDataSourceChange(() => setSource(getFarmDataSource())), []);
  useEffect(() => source.subscribeShelfHistory(setReadings), [source]);

  const points = useMemo(() => (readings ? toPoints(readings, range, Date.now()) : []), [range, readings]);
  return { points, live: readings !== null };
}
