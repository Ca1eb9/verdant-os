"use client";

import { useEffect, useState } from "react";
import { getFarmDataSource, onFarmDataSourceChange } from "@/lib/farm/data-source";
import type { FarmAlert } from "@/lib/farm/types";

/** The farm's alerts from its services, newest first; null when the source has none yet */
export function useFarmAlerts() {
  const [source, setSource] = useState(getFarmDataSource);
  const [alerts, setAlerts] = useState<FarmAlert[] | null>(null);

  useEffect(() => onFarmDataSourceChange(() => setSource(getFarmDataSource())), []);
  useEffect(() => source.subscribeAlerts(setAlerts), [source]);

  return alerts;
}
