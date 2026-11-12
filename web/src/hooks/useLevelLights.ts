"use client";

import { useMemo } from "react";
import { useSelectedFarm } from "@/components/farms/FarmContext";
import { useFarmTelemetry } from "@/hooks/useFarmTelemetry";
import { useGrowLights } from "@/hooks/useGrowLights";
import type { Level } from "@/lib/farm/map/layout";
import type { LevelLight } from "@/lib/farm/map/renderer";

/**
 * Draw the map's lights from the light switches instead of the light sensors,
 * for a day the sensors aren't working (dashboard.env, web/.env.local). Fixed
 * at build time. Remotely there are no switches, so the sensors still draw.
 */
const FROM_SWITCHES = process.env.NEXT_PUBLIC_MAP_LIGHTS_FROM_SWITCHES === "true";
/**
 * Draw each level's light fully on or off from its sensor (on at ON_OFF_LUX in
 * the renderer) instead of in proportion to its reading. FROM_SWITCHES, when
 * it applies, draws on or off anyway. Fixed at build time.
 */
const ON_OFF = process.env.NEXT_PUBLIC_MAP_LIGHTS_ON_OFF === "true";

/**
 * Each level's grow light, by its z, for the farm map: the light reading for
 * that level, or with FROM_SWITCHES its switch. A level with no switch of its
 * own follows whether any light is on, as one supply lights every level. Null
 * where there's neither (no reading yet, stale, the sensor didn't read, or no
 * sensor faces that level), so the map never shows a light it doesn't know is on.
 */
export function useLevelLights(levels: Level[]): Map<number, LevelLight> {
  const { farm } = useSelectedFarm();
  const { reading, liveStatus } = useFarmTelemetry(farm?.id ?? null);
  const { lights: switches } = useGrowLights();

  return useMemo(() => {
    if (FROM_SWITCHES && switches?.lights.length) {
      const anyOn = switches.lights.some((light) => light.on);
      return new Map(levels.map((level) => {
        const own = switches.lights.find((light) => light.level === level.z);
        return [level.z, { switchedOn: own ? own.on : anyOn }];
      }));
    }
    const lights = liveStatus === "live" ? (reading?.lights ?? []) : [];
    return new Map(levels.map((level) => {
      const lux = lights.find((light) => light.level === level.z)?.lux ?? null;
      return [level.z, lux === null ? null : { lux, onOff: ON_OFF }];
    }));
  }, [levels, liveStatus, reading, switches]);
}
