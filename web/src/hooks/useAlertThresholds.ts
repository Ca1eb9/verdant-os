"use client";

import { useEffect, useState } from "react";
import { getFarmDataSource, onFarmDataSourceChange } from "@/lib/farm/data-source";
import type { ThresholdLimits } from "@/lib/farm/types";

/** The alert engine's limits per metric; null until the data source has them */
export function useAlertThresholds() {
  const [source, setSource] = useState(getFarmDataSource);
  const [thresholds, setThresholds] = useState<ThresholdLimits[] | null>(null);

  useEffect(() => onFarmDataSourceChange(() => setSource(getFarmDataSource())), []);
  useEffect(() => source.subscribeThresholds(setThresholds), [source]);

  return thresholds;
}
