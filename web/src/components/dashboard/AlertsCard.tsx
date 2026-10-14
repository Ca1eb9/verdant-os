"use client";

import Link from "next/link";
import { useMemo } from "react";
import { usePreferences } from "@/components/preferences/PreferencesProvider";
import { useFarmAlerts } from "@/hooks/useFarmAlerts";
import styles from "@/components/dashboard/DashboardView.module.css";

const SHOWN_ALERTS = 4;

interface AlertRow {
  key: string;
  title: string;
  severity: "info" | "warning" | "critical";
  source: string;
  at: number;
}

/** The newest alerts from the farm's services (orchestrator, alert engine) */
export function AlertsCard() {
  const { fmt } = usePreferences();
  const farmAlerts = useFarmAlerts();

  const rows = useMemo<AlertRow[]>(
    () =>
      (farmAlerts ?? []).slice(0, SHOWN_ALERTS).map((alert) => ({
        key: alert.alert_id,
        title: alert.message,
        severity: alert.severity,
        source: alert.source,
        at: alert.timestamp,
      })),
    [farmAlerts],
  );

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
        <p className={styles.emptyNote}>
          {farmAlerts === null ? "Alerts aren't available here yet." : "No alerts right now."}
        </p>
      )}
    </article>
  );
}
