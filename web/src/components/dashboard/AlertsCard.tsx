"use client";

import Link from "next/link";
import { useMemo } from "react";
import { usePreferences } from "@/components/preferences/PreferencesProvider";
import { useFarmAlerts } from "@/hooks/useFarmAlerts";
import type { TelemetryAlert } from "@/lib/types";
import styles from "@/components/dashboard/DashboardView.module.css";

const SHOWN_ALERTS = 4;

interface AlertRow {
  key: string;
  title: string;
  severity: "info" | "warning" | "critical";
  source: string;
  at: number;
}

/**
 * The newest alerts: the sensor readings' active ones (passed in, so the
 * dashboard reads its feed once) and those from the farm's robots and services.
 */
export function AlertsCard({ environmentAlerts }: { environmentAlerts: TelemetryAlert[] }) {
  const { fmt } = usePreferences();
  const farmAlerts = useFarmAlerts();

  const rows = useMemo<AlertRow[]>(() => {
    const environment = environmentAlerts.map((alert) => ({
      key: alert.id,
      title: alert.title,
      severity: alert.severity,
      source: "Environment",
      at: new Date(alert.detectedAt).getTime(),
    }));
    const services = (farmAlerts ?? []).map((alert) => ({
      key: alert.alert_id,
      title: alert.message,
      severity: alert.severity,
      source: alert.source,
      at: alert.timestamp,
    }));
    return [...environment, ...services].sort((a, b) => b.at - a.at).slice(0, SHOWN_ALERTS);
  }, [environmentAlerts, farmAlerts]);

  return (
    <article className={`glassPanel ${styles.sensorCard} ${styles.alertsCard}`}>
      <div className={styles.sensorTop}>
        <h2 className={styles.sensorTitle}>Alerts</h2>
        <Link href="/alerts" className={styles.cardLink}>
          Open alerts →
        </Link>
      </div>

      {rows.length ? (
        <ul className={styles.robotList}>
          {rows.map((row) => (
            <li key={row.key} className={styles.metricTile}>
              <div className={styles.metricLabelRow}>
                <strong>{row.title}</strong>
                <span className={`${styles.robotState} ${styles[row.severity]}`}>{row.severity}</span>
              </div>
              <span className={styles.metricLabel} suppressHydrationWarning>
                {row.source} · {fmt.time(row.at)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.emptyNote}>No alerts right now.</p>
      )}
    </article>
  );
}
