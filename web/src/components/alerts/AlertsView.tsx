"use client";

import { useMemo, useState } from "react";
import { useSelectedFarm } from "@/components/farms/FarmContext";
import { NoFarmNotice } from "@/components/farms/NoFarmNotice";
import { usePreferences } from "@/components/preferences/PreferencesProvider";
import { listAlerts, useFarmAlerts } from "@/hooks/useFarmAlerts";
import { useFarmTelemetry } from "@/hooks/useFarmTelemetry";
import styles from "@/components/alerts/AlertsView.module.css";

export function AlertsView() {
  const { activeFarmId, farm } = useSelectedFarm();
  const { fmt } = usePreferences();
  const [limit, setLimit] = useState<10 | 20>(20);
  const { lastUpdate } = useFarmTelemetry(activeFarmId);
  // From the farm's services: the orchestrator and the alert engine
  const farmAlerts = useFarmAlerts();
  const visibleFarmAlerts = useMemo(
    () => (farmAlerts ? listAlerts(farmAlerts).slice(0, limit) : []),
    [farmAlerts, limit],
  );

  // Open problems only: a resolved alert no longer needs anyone
  const counts = useMemo(() => {
    const severities = visibleFarmAlerts
      .filter((listed) => listed.resolvedAt === null)
      .map(({ alert }) => alert.severity);
    return {
      warning: severities.filter((severity) => severity === "warning").length,
      critical: severities.filter((severity) => severity === "critical").length,
    };
  }, [visibleFarmAlerts]);

  if (!farm) return <NoFarmNotice title="System alerts" />;

  return (
    <section className="pageSection">
      <header className={styles.hero}>
        <div className={styles.heroContent}>
          <span className="eyebrow">System alerts</span>
          <h1 className="pageTitle">Alerts</h1>
          <p className="pageLead">
            Alerts from {farm.name}&apos;s robots, shelves and services.
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
          <strong className={styles.summaryValue}>{visibleFarmAlerts.length}</strong>
          <span className={styles.summaryDetail}>Newest recognized warnings first</span>
        </article>
        <article className={`glassPanel ${styles.summaryCard}`}>
          <span className={styles.summaryLabel}>Warnings</span>
          <strong className={styles.summaryValue}>{counts.warning}</strong>
          <span className={styles.summaryDetail}>Open, outside the target range</span>
        </article>
        <article className={`glassPanel ${styles.summaryCard}`}>
          <span className={styles.summaryLabel}>Critical</span>
          <strong className={styles.summaryValue}>{counts.critical}</strong>
          <span className={styles.summaryDetail}>Open, need attention now</span>
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
        {farmAlerts === null ? (
          <article className={`glassPanel ${styles.emptyState}`}>
            <strong>Alerts aren&apos;t available here yet.</strong>
            <span>They show on the farm&apos;s Wi-Fi.</span>
          </article>
        ) : visibleFarmAlerts.length === 0 ? (
          <article className={`glassPanel ${styles.emptyState}`}>
            <strong>No alerts.</strong>
            <span>Alerts raised since the dashboard opened show here.</span>
          </article>
        ) : (
          visibleFarmAlerts.map(({ alert, resolvedAt }) => (
            <article
              key={alert.alert_id}
              className={`glassPanel ${styles.alertCard} ${resolvedAt !== null ? styles.resolved : ""}`}
            >
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
                {resolvedAt !== null ? (
                  <span>
                    <strong>Resolved:</strong> {fmt.time(resolvedAt)}
                  </span>
                ) : null}
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
    </section>
  );
}
