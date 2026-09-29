"use client";

import { useEffect, useMemo, useState } from "react";
import { useSelectedFarm } from "@/components/farms/FarmContext";
import { usePreferences } from "@/components/preferences/PreferencesProvider";
import { HeartbeatPanel, ago, isSilent, type Heartbeat } from "@/components/alerts/Heartbeats";
import { useFarmLive } from "@/hooks/useFarmLive";
import { SENSOR_STALE_MS, useFarmTelemetry } from "@/hooks/useFarmTelemetry";
import { TimeWindowPicker } from "@/components/ui/TimeWindowPicker";
import { ROBOT_STALE_MS } from "@/lib/farm/robots";
import { TIME_WINDOWS } from "@/lib/time-windows";
import type { FarmAlert } from "@/lib/farm/types";
import styles from "@/components/alerts/AlertsView.module.css";

const PAGE_SIZE = 25;
const POLL_MS = 10_000;

export function AlertsView() {
  const { activeFarmId, farm } = useSelectedFarm();
  const { fmt, prefs } = usePreferences();
  const timeWindow = prefs.timeWindow;
  const windowLabel = TIME_WINDOWS[timeWindow].label;
  const [shown, setShown] = useState(PAGE_SIZE);
  const { snapshot, lastUpdate } = useFarmTelemetry(activeFarmId);
  const { source, robots } = useFarmLive();
  // alerts and ages depend on the browser clock, so build them after mount to match the server render
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(id);
  }, []);

  // alerts come from the farm's alert engine via the data source; nothing is
  // stored here, so a reload simply asks again
  const [alerts, setAlerts] = useState<FarmAlert[]>([]);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      source
        .listAlerts(Date.now() - TIME_WINDOWS[timeWindow].ms)
        .then((list) => !cancelled && setAlerts([...list].sort((a, b) => b.timestamp - a.timestamp)))
        .catch(() => !cancelled && setAlerts([]));
    void load();
    const id = window.setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [activeFarmId, source, timeWindow]);

  // every device that reports in: the shelf sensor feed and each robot
  const beats = useMemo<Heartbeat[]>(
    () => [
      { id: snapshot.deviceId, kind: "Shelf sensor", lastSeen: lastUpdate.getTime(), staleAfterMs: SENSOR_STALE_MS },
      ...robots.map((robot) => ({ id: robot.id, kind: "Robot", lastSeen: robot.lastSeen, staleAfterMs: ROBOT_STALE_MS })),
    ],
    [lastUpdate, robots, snapshot.deviceId],
  );
  const silent = now === null ? [] : beats.filter((beat) => isSilent(beat, now));

  useEffect(() => setShown(PAGE_SIZE), [activeFarmId, timeWindow]);

  const recent = useMemo(() => {
    if (now === null) return [];
    const since = now - TIME_WINDOWS[timeWindow].ms;
    return alerts.filter((alert) => alert.timestamp >= since);
  }, [alerts, now, timeWindow]);

  const counts = useMemo(
    () => ({
      warning: recent.filter((alert) => alert.severity === "warning").length,
      critical: recent.filter((alert) => alert.severity === "critical").length,
    }),
    [recent],
  );

  const renderAlert = (alert: FarmAlert) => (
    <article key={alert.alert_id} className={`glassPanel ${styles.alertCard}`}>
      <div className={styles.alertHead}>
        <div>
          <span className="eyebrow">
            {alert.source} {"\u00B7"} {alert.metric}
          </span>
          <h2 className={styles.alertTitle}>{alert.message}</h2>
        </div>
        <span className={`${styles.severity} ${styles[alert.severity]}`}>{alert.severity}</span>
      </div>

      <p className={styles.alertMessage}>
        Raised by {alert.source_type} {alert.source}.
      </p>

      <div className={styles.alertMeta}>
        <span>
          <strong>Detected:</strong> {fmt.time(alert.timestamp)}
        </span>
        <span>
          <strong>Value:</strong> {alert.value}
        </span>
        <span>
          <strong>Threshold:</strong> {alert.threshold}
        </span>
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
          <span className={styles.summaryLabel}>Alerts</span>
          <strong className={styles.summaryValue}>{recent.length}</strong>
          <span className={styles.summaryDetail}>Raised in the last {windowLabel}</span>
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
          <span className={styles.summaryLabel}>Devices reporting</span>
          <strong className={styles.summaryValue}>
            {now === null ? "\u2014" : `${beats.length - silent.length} / ${beats.length}`}
          </strong>
          <span className={styles.summaryDetail}>
            {now === null
              ? "Checking heartbeats"
              : silent.length === 0
                ? `All reporting \u00B7 oldest ${ago(now - Math.min(...beats.map((beat) => beat.lastSeen)))}`
                : silent.length === 1
                  ? `${silent[0].id} last heard ${ago(now - silent[0].lastSeen)}`
                  : `${silent.length} silent: ${silent.map((beat) => beat.id).join(", ")}`}
          </span>
        </article>
      </div>

      {now !== null ? <HeartbeatPanel beats={beats} now={now} /> : null}

      <div className={styles.list}>
        <h2 className={styles.listTitle}>Last {windowLabel}</h2>
        {recent.length === 0 ? (
          <article className={`glassPanel ${styles.emptyState}`}>
            <strong>No alerts in the last {windowLabel}.</strong>
            <span>The farm has not raised any alerts in this window.</span>
          </article>
        ) : (
          recent.slice(0, shown).map(renderAlert)
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
