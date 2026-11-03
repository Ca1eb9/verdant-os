"use client";

import { useMemo } from "react";
import { useSelectedFarm } from "@/components/farms/FarmContext";
import { useFarmTelemetry } from "@/hooks/useFarmTelemetry";
import type { Level } from "@/lib/farm/map/layout";

/**
 * Each level's grow light in lux, by its z, for the farm map. The shelf node's
 * two light sensors face the lights of the farm's two levels: light_lux the
 * bottom's, light_top_lux the one above it. Null where there's no current
 * reading (none yet, stale, the sensor didn't read, or a level above those
 * two), so the map never shows a light it doesn't know is on.
 */
export function useLevelLights(levels: Level[]): Map<number, number | null> {
  const { farm } = useSelectedFarm();
  const { reading, liveStatus } = useFarmTelemetry(farm?.id ?? null);

  return useMemo(() => {
    const current = liveStatus === "live" ? reading : null;
    const byLevel = [current?.lightLux ?? null, current?.lightTopLux ?? null];
    return new Map(levels.map((level, i) => [level.z, byLevel[i] ?? null]));
  }, [levels, liveStatus, reading]);
}
