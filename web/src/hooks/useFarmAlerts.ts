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

export interface ListedAlert {
  alert: FarmAlert;
  /** When a later alert resolved it (FarmAlert.timestamp), or null while it's open */
  resolvedAt: number | null;
}

/**
 * The alerts to list, from a list newest first, each marked with when it
 * resolved. An alert is resolved by one naming it in `resolves`, or by a
 * resolved newer alert about the same reading (a reminder or an escalation
 * of the same problem). An info alert that only resolves another is folded
 * into it, unless that one isn't in the list.
 */
export function listAlerts(alerts: FarmAlert[]): ListedAlert[] {
  const ids = new Set(alerts.map((alert) => alert.alert_id));
  const resolvedBy = new Map<string, number>();
  /** Per reading: whether its newer alerts were resolved, and when */
  const readingResolvedAt = new Map<string, number | null>();
  const listed: ListedAlert[] = [];

  for (const alert of alerts) {
    const key = alert.metric ? alertKey(alert.source_type, alert.source, alert.metric) : null;
    const clears = alert.severity === "info" && alert.resolves !== null;
    const resolvedAt = resolvedBy.get(alert.alert_id) ?? (key ? readingResolvedAt.get(key) ?? null : null);

    if (alert.resolves) resolvedBy.set(alert.resolves, alert.timestamp);
    if (key) readingResolvedAt.set(key, clears ? alert.timestamp : resolvedAt);
    if (!clears || !ids.has(alert.resolves as string)) listed.push({ alert, resolvedAt });
  }
  return listed;
}
