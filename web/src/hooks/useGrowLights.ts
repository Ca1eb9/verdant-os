"use client";

import { useEffect, useState } from "react";
import { getFarmDataSource, onFarmDataSourceChange } from "@/lib/farm/data-source";
import type { LightsState } from "@/lib/farm/types";

/**
 * The grow lights and the operator's switches, and a way to flip one; lights
 * is null where they can't be switched (remotely) or before the shelf bridge
 * has said
 */
export function useGrowLights() {
  const [source, setSource] = useState(getFarmDataSource);
  const [lights, setLights] = useState<LightsState | null>(null);

  useEffect(() => onFarmDataSourceChange(() => setSource(getFarmDataSource())), []);
  useEffect(() => source.subscribeLights(setLights), [source]);

  return { lights, setLight: (light: number, on: boolean) => source.setLight(light, on) };
}
