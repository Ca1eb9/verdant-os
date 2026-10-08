"use client";

import { useEffect, useMemo, useState } from "react";
import { useSelectedFarm } from "@/components/farms/FarmContext";
import { NoFarmNotice } from "@/components/farms/NoFarmNotice";
import { readTelemetryAlerts } from "@/lib/alerts";
import { usePreferences } from "@/components/preferences/PreferencesProvider";
import { useFarmAlerts } from "@/hooks/useFarmAlerts";
import { useFarmTelemetry } from "@/hooks/useFarmTelemetry";
import type { TelemetryAlert } from "@/lib/types";
import styles from "@/components/alerts/AlertsView.module.css";

function alertSignature(alert: Pick<TelemetryAlert, "farmId" | "metric" | "severity" | "title" | "threshold">) {
  return [alert.farmId, alert.metric, alert.severity, alert.title, alert.threshold ?? ""].join("|");
}

export function AlertsView() {
  const { activeFarmId, farm } = useSelectedFarm();
  const { fmt } = usePreferences();
  const [limit, setLimit] = useState<10 | 20>(20);
  const { alerts: currentAlerts, lastUpdate } = useFarmTelemetry(activeFarmId);
  // From the farm's services (orchestrator, alert engine); the list below is
  // worked out here from the sensor readings
  const farmAlerts = useFarmAlerts();
  const visibleFarmAlerts = useMemo(() => farmAlerts?.slice(0, limit) ?? [], [farmAlerts, limit]);
  // stored alerts live in the browser, so build the list after mount to match the server render
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const alerts = useMemo(() => {
    if (!mounted || !activeFarmId) return [];
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

  const counts = useMemo(() => {
    const severities = [...alerts, ...visibleFarmAlerts].map((alert) => alert.severity);
    return {
      warning: severities.filter((severity) => severity === "warning").length,
      critical: severities.filter((severity) => severity === "critical").length,
    };
  }, [alerts, visibleFarmAlerts]);

  if (!farm) return <NoFarmNotice title="System alerts" />;

  return (
    <section className="pageSection">
      <header className={styles.hero}>
        <div className={styles.heroContent}>
          <span className="eyebrow">System alerts</span>
          <h1 className="pageTitle">Alerts</h1>
          <p className="pageLead">
            Alerts from {farm.name}&apos;s robots and services, and from its sensor readings.
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
          <strong className={styles.summaryValue}>{alerts.length + visibleFarmAlerts.length}</strong>
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
            {lastUpdate ? fmt.time(lastUpdate) : "Never"}
          </strong>
          <span className={styles.summaryDetail}>Last sensor heartbeat seen</span>
        </article>
      </div>

      <div className={styles.list}>
        <span className="eyebrow">Robots and services</span>
        {farmAlerts === null ? (
          <article className={`glassPanel ${styles.emptyState}`}>
            <strong>Robot and service alerts aren&apos;t available here yet.</strong>
            <span>They show on the farm&apos;s Wi-Fi.</span>
          </article>
        ) : visibleFarmAlerts.length === 0 ? (
          <article className={`glassPanel ${styles.emptyState}`}>
            <strong>No robot or service alerts.</strong>
            <span>Alerts raised since the dashboard opened show here.</span>
          </article>
        ) : (
          visibleFarmAlerts.map((alert) => (
            <article key={alert.alert_id} className={`glassPanel ${styles.alertCard}`}>
              <div className={styles.alertHead}>
                <div>
                  <span className="eyebrow">
                    {alert.source_type} · {alert.source}
                  </span>
                  <h2 className={styles.alertTitle}>{alert.message}</h2>
                </div>
                <span className={`${styles.severity} ${styles[alert.severity]}`}>{alert.severity}</span>
              </div>

              <div className={styles.alertMeta}>
                <span>
                  <strong>Raised:</strong> {fmt.time(alert.timestamp)}
                </span>
                {/* metric is empty for alerts that aren't about a reading */}
                {alert.metric ? (
                  <>
                    <span>
                      <strong>Value:</strong> {alert.value}
                    </span>
                    <span>
                      <strong>Threshold:</strong> {alert.threshold}
                    </span>
                  </>
                ) : null}
              </div>
            </article>
          ))
        )}
      </div>

      <div className={styles.list}>
        <span className="eyebrow">Environment</span>
        {alerts.length === 0 ? (
          <article className={`glassPanel ${styles.emptyState}`}>
            <strong>No environment alerts right now.</strong>
            <span>Sensor readings are within range for the selected farm.</span>
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

              {/* message text is stored when the alert fires, in the units it was recorded with */}
              <p className={styles.alertMessage}>{alert.message}</p>

              <div className={styles.alertMeta}>
                <span>
                  <strong>Detected:</strong> {fmt.time(alert.detectedAt)}
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
