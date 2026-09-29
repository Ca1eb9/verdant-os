"use client";

import { useEffect, useMemo, useState } from "react";
import { useSelectedFarm } from "@/components/farms/FarmContext";
import { buildAlertSignature, evaluateTelemetryAlerts, readTelemetryAlerts } from "@/lib/alerts";
import { usePreferences } from "@/components/preferences/PreferencesProvider";
import { useFarmTelemetry } from "@/hooks/useFarmTelemetry";
import { TimeWindowPicker } from "@/components/ui/TimeWindowPicker";
import { TIME_WINDOWS } from "@/lib/time-windows";
import type { TelemetryAlert } from "@/lib/types";
import styles from "@/components/alerts/AlertsView.module.css";

const PAGE_SIZE = 25;

export function AlertsView() {
  const { activeFarmId, farm } = useSelectedFarm();
  const { fmt, prefs } = usePreferences();
  const timeWindow = prefs.timeWindow;
  const windowLabel = TIME_WINDOWS[timeWindow].label;
  const [shown, setShown] = useState(PAGE_SIZE);
  const { snapshot, lastUpdate } = useFarmTelemetry(activeFarmId);
  // stored alerts live in the browser, so build the list after mount to match the server render
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => setShown(PAGE_SIZE), [activeFarmId, timeWindow]);

  const currentAlerts = useMemo(
    () => evaluateTelemetryAlerts(farm, snapshot, lastUpdate, Date.now()),
    [farm, lastUpdate, snapshot],
  );

  // active: shown whatever the window, dated from when they started.
  // recent: earlier occurrences that started inside the window, newest first.
  const { active, recent } = useMemo(() => {
    if (now === null) return { active: [], recent: [] };
    const stored = [...readTelemetryAlerts(activeFarmId)].sort(
      (left, right) => new Date(right.detectedAt).getTime() - new Date(left.detectedAt).getTime(),
    );
    const ongoing = new Set<string>();

    const active = currentAlerts.map((alert) => {
      const signature = buildAlertSignature(alert);
      const started = stored.find((item) => buildAlertSignature(item) === signature);
      if (started) ongoing.add(started.id);
      return started ? { ...alert, detectedAt: started.detectedAt } : alert;
    });

    const since = now - TIME_WINDOWS[timeWindow].ms;
    const recent = stored.filter(
      (alert) => !ongoing.has(alert.id) && new Date(alert.detectedAt).getTime() >= since,
    );

    return { active, recent };
  }, [activeFarmId, currentAlerts, now, timeWindow]);

  const counts = useMemo(() => {
    const inWindow = [...active, ...recent];
    return {
      warning: inWindow.filter((alert) => alert.severity === "warning").length,
      critical: inWindow.filter((alert) => alert.severity === "critical").length,
    };
  }, [active, recent]);

  const renderAlert = (alert: TelemetryAlert, ongoing: boolean) => (
    <article key={alert.id} className={`glassPanel ${styles.alertCard}`}>
      <div className={styles.alertHead}>
        <div>
          <span className="eyebrow">{alert.metric}</span>
          <h2 className={styles.alertTitle}>{alert.title}</h2>
        </div>
        <span className={`${styles.severity} ${styles[alert.severity]}`}>{alert.severity}</span>
      </div>

      {/* message text is stored when the alert fires, in the units it was recorded with */}
      <p className={styles.alertMessage}>{alert.message}</p>

      <div className={styles.alertMeta}>
        <span>
          <strong>{ongoing ? "Active since:" : "Detected:"}</strong> {fmt.time(alert.detectedAt)}
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
          <TimeWindowPicker />
        </div>
      </div>

      <div className={styles.summaryGrid}>
        <article className={`glassPanel ${styles.summaryCard}`}>
          <span className={styles.summaryLabel}>Active now</span>
          <strong className={styles.summaryValue}>{active.length}</strong>
          <span className={styles.summaryDetail}>Out of range at this moment</span>
        </article>
        <article className={`glassPanel ${styles.summaryCard}`}>
          <span className={styles.summaryLabel}>Warnings</span>
          <strong className={styles.summaryValue}>{counts.warning}</strong>
          <span className={styles.summaryDetail}>Soft threshold breaches, last {windowLabel}</span>
        </article>
        <article className={`glassPanel ${styles.summaryCard}`}>
          <span className={styles.summaryLabel}>Critical</span>
          <strong className={styles.summaryValue}>{counts.critical}</strong>
          <span className={styles.summaryDetail}>Hard threshold breaches, last {windowLabel}</span>
        </article>
        <article className={`glassPanel ${styles.summaryCard}`}>
          <span className={styles.summaryLabel}>Heartbeat</span>
          <strong className={styles.summaryValue} suppressHydrationWarning>
            {fmt.time(lastUpdate)}
          </strong>
          <span className={styles.summaryDetail}>Last sensor heartbeat seen</span>
        </article>
      </div>

      {active.length ? (
        <div className={styles.list}>
          <h2 className={styles.listTitle}>Active now</h2>
          {active.map((alert) => renderAlert(alert, true))}
        </div>
      ) : null}

      <div className={styles.list}>
        <h2 className={styles.listTitle}>Last {windowLabel}</h2>
        {recent.length === 0 ? (
          <article className={`glassPanel ${styles.emptyState}`}>
            <strong>No {active.length ? "other " : ""}alerts in the last {windowLabel}.</strong>
            <span>{active.length ? "Only the active alerts above." : "System is within range for the selected farm."}</span>
          </article>
        ) : (
          recent.slice(0, shown).map((alert) => renderAlert(alert, false))
        )}
        {recent.length > shown ? (
          <button type="button" className={styles.showMore} onClick={() => setShown((count) => count + PAGE_SIZE)}>
            Show more ({recent.length - shown} older)
          </button>
        ) : null}
      </div>
    </section>
  );
}
