"use client";

import { useMemo } from "react";
import { useSelectedFarm } from "@/components/farms/FarmContext";
import { useFarmTelemetry } from "@/hooks/useFarmTelemetry";
import type { Level } from "@/lib/farm/map/layout";

/**
 * Each level's grow light in lux, by its z, for the farm map: the light
 * reading for that level. Null where there's no current reading (none yet,
 * stale, the sensor didn't read, or no sensor faces that level), so the map
 * never shows a light it doesn't know is on.
 */
export function useLevelLights(levels: Level[]): Map<number, number | null> {
  const { farm } = useSelectedFarm();
  const { reading, liveStatus } = useFarmTelemetry(farm?.id ?? null);

  return useMemo(() => {
    const lights = liveStatus === "live" ? (reading?.lights ?? []) : [];
    return new Map(levels.map((level) => [level.z, lights.find((light) => light.level === level.z)?.lux ?? null]));
  }, [levels, liveStatus, reading]);
}
