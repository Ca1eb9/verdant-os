"use client";

import { useMemo } from "react";
import { useSelectedFarm } from "@/components/farms/FarmContext";
import { useFarmTelemetry } from "@/hooks/useFarmTelemetry";
import type { Level } from "@/lib/farm/map/layout";

/**
 * Each level's grow light in lux, by its z, for the farm map. The shelf node's
 * two light sensors face the lights of the farm's two levels: light_lux the
 * lowest level's, light_top_lux the highest's, as the Light card names them.
 * Null where there's no current reading (none yet, stale, the sensor didn't
 * read, or a level between those two, as in the 3-level default layout), so
 * the map never shows a light it doesn't know is on.
 */
export function useLevelLights(levels: Level[]): Map<number, number | null> {
  const { farm } = useSelectedFarm();
  const { reading, liveStatus } = useFarmTelemetry(farm?.id ?? null);

  return useMemo(() => {
    const current = liveStatus === "live" ? reading : null;
    const top = levels.length > 1 ? levels.length - 1 : -1;
    return new Map(levels.map((level, i) => [
      level.z,
      i === 0 ? (current?.lightLux ?? null) : i === top ? (current?.lightTopLux ?? null) : null,
    ]));
  }, [levels, liveStatus, reading]);
}
