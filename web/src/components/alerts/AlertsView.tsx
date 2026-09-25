"use client";

import { useEffect, useMemo, useState } from "react";
import { useSelectedFarm } from "@/components/farms/FarmContext";
import { evaluateTelemetryAlerts, readTelemetryAlerts } from "@/lib/alerts";
import { formatTimestamp } from "@/lib/format";
import { useFarmTelemetry } from "@/hooks/useFarmTelemetry";
import type { TelemetryAlert } from "@/lib/types";
import styles from "@/components/alerts/AlertsView.module.css";

function alertSignature(alert: Pick<TelemetryAlert, "farmId" | "metric" | "severity" | "title" | "threshold">) {
  return [alert.farmId, alert.metric, alert.severity, alert.title, alert.threshold ?? ""].join("|");
}

export function AlertsView() {
  const { activeFarmId, farm } = useSelectedFarm();
  const [limit, setLimit] = useState<10 | 20>(20);
  const { snapshot, lastUpdate } = useFarmTelemetry(activeFarmId);
  // stored alerts live in the browser, so build the list after mount to match the server render
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const currentAlerts = useMemo(
    () => evaluateTelemetryAlerts(farm, snapshot, lastUpdate, Date.now()),
    [farm, lastUpdate, snapshot],
  );

  const alerts = useMemo(() => {
    if (!mounted) return [];
    const combined = [...currentAlerts, ...readTelemetryAlerts(activeFarmId)];
    const seen = new Set<string>();
    const deduped: TelemetryAlert[] = [];

    for (const alert of combined.sort(
      (left, right) =>
        new Date(right.detectedAt).getTime() - new Date(left.detectedAt).getTime(),
    )) {
      const key = alertSignature(alert);

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      deduped.push(alert);
    }

    return deduped.slice(0, limit);
  }, [activeFarmId, currentAlerts, limit, mounted]);

  const counts = useMemo(
    () => ({
      warning: alerts.filter((alert) => alert.severity === "warning").length,
      critical: alerts.filter((alert) => alert.severity === "critical").length,
    }),
    [alerts],
  );

  return (
    <section className="pageSection">
      <header className={styles.hero}>
        <div className={styles.heroContent}>
          <span className="eyebrow">System alerts</span>
          <h1 className="pageTitle">Alerts</h1>
          <p className="pageLead">
            Review the latest ingestion and sensor warnings for {farm.name}.
          </p>
        </div>
      </header>

      <div className={styles.toolbar}>
        <div className={styles.selectorGroup}>
          <span className={styles.metaLabel}>Window</span>
          <div className={styles.rangeRow}>
            {[10, 20].map((value) => (
              <button
                key={value}
                type="button"
                className={`${styles.rangeButton} ${limit === value ? styles.rangeActive : ""}`}
                onClick={() => setLimit(value as 10 | 20)}
              >
                Last {value}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className={styles.summaryGrid}>
        <article className={`glassPanel ${styles.summaryCard}`}>
          <span className={styles.summaryLabel}>Visible alerts</span>
          <strong className={styles.summaryValue}>{alerts.length}</strong>
          <span className={styles.summaryDetail}>Newest recognized warnings first</span>
        </article>
        <article className={`glassPanel ${styles.summaryCard}`}>
          <span className={styles.summaryLabel}>Warnings</span>
          <strong className={styles.summaryValue}>{counts.warning}</strong>
          <span className={styles.summaryDetail}>Soft threshold breaches</span>
        </article>
        <article className={`glassPanel ${styles.summaryCard}`}>
          <span className={styles.summaryLabel}>Critical</span>
          <strong className={styles.summaryValue}>{counts.critical}</strong>
          <span className={styles.summaryDetail}>Hard threshold breaches</span>
        </article>
        <article className={`glassPanel ${styles.summaryCard}`}>
          <span className={styles.summaryLabel}>Heartbeat</span>
          <strong className={styles.summaryValue} suppressHydrationWarning>
            {formatTimestamp(lastUpdate)}
          </strong>
          <span className={styles.summaryDetail}>Last sensor heartbeat seen</span>
        </article>
      </div>

      <div className={styles.list}>
        {alerts.length === 0 ? (
          <article className={`glassPanel ${styles.emptyState}`}>
            <strong>No alerts right now.</strong>
            <span>System is within range for the selected farm.</span>
          </article>
        ) : (
          alerts.map((alert) => (
            <article key={alert.id} className={`glassPanel ${styles.alertCard}`}>
              <div className={styles.alertHead}>
                <div>
                  <span className="eyebrow">{alert.metric}</span>
                  <h2 className={styles.alertTitle}>{alert.title}</h2>
                </div>
                <span className={`${styles.severity} ${styles[alert.severity]}`}>
                  {alert.severity}
                </span>
              </div>

              <p className={styles.alertMessage}>{alert.message}</p>

              <div className={styles.alertMeta}>
                <span>
                  <strong>Detected:</strong> {formatTimestamp(alert.detectedAt)}
                </span>
                {alert.value ? (
                  <span>
                    <strong>Value:</strong> {alert.value}
                  </span>
                ) : null}
                {alert.threshold ? (
                  <span>
                    <strong>Threshold:</strong> {alert.threshold}
                  </span>
                ) : null}
              </div>
            </article>
          ))
        )}
      </div>
    </section>
  );
}
