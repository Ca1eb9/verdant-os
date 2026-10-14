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

/** Keys an alert by the reading it's about, e.g. `shelf:shelf-1:ph` */
export function alertKey(sourceType: FarmAlert["source_type"], source: string, metric: string) {
  return `${sourceType}:${source}:${metric}`;
}

/**
 * Each reading's current alert: its newest one, from a list newest first.
 * Alerts that aren't about a reading (empty metric) are left out.
 */
export function currentAlertsByReading(alerts: FarmAlert[]) {
  const current = new Map<string, FarmAlert>();
  for (const alert of alerts) {
    const key = alertKey(alert.source_type, alert.source, alert.metric);
    if (alert.metric && !current.has(key)) current.set(key, alert);
  }
  return current;
}
