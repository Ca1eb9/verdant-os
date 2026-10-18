"use client";

import { useEffect, useMemo, useState } from "react";
import { useSelectedFarm } from "@/components/farms/FarmContext";
import { NoFarmNotice } from "@/components/farms/NoFarmNotice";
import { usePreferences } from "@/components/preferences/PreferencesProvider";
import { TimeWindowPicker } from "@/components/ui/TimeWindowPicker";
import { isSilent, useDeviceHeartbeats, type Heartbeat } from "@/hooks/useDeviceHeartbeats";
import { listAlerts, useFarmAlerts, type ListedAlert } from "@/hooks/useFarmAlerts";
import { useFarmTelemetry } from "@/hooks/useFarmTelemetry";
import { formatAgo } from "@/lib/format";
import { TIME_WINDOWS } from "@/lib/time-windows";
import styles from "@/components/alerts/AlertsView.module.css";

// Earlier alerts are listed this many at a time
const PAGE_SIZE = 25;
// Silent devices named in the summary card; the list below names them all
const NAMED_SILENT = 3;
const KIND_LABEL: Record<Heartbeat["kind"], string> = { robot: "Robot", shelf: "Shelf sensor" };

/** An open warning or critical alert: it still needs someone, whatever the window */
function isOpen({ alert, resolvedAt }: ListedAlert) {
  return resolvedAt === null && alert.severity !== "info";
}

function AlertCard({ listed }: { listed: ListedAlert }) {
  const { fmt } = usePreferences();
  const { alert, resolvedAt } = listed;

  return (
    <article className={`glassPanel ${styles.alertCard} ${resolvedAt !== null ? styles.resolved : ""}`}>
      <div className={styles.alertHead}>
        <div>
          <span className="eyebrow">
            {alert.source_type} · {alert.source}
          </span>
          <h3 className={styles.alertTitle}>{alert.message}</h3>
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
  );
}

function DeviceList({ beats, now }: { beats: Heartbeat[]; now: number }) {
  const { fmt } = usePreferences();

  return (
    <ul className={`glassPanel ${styles.devices}`}>
      {beats.map((beat) => {
        const silent = isSilent(beat, now);
        return (
          <li key={`${beat.kind}:${beat.id}`} className={styles.device}>
            <span className={`statusDot ${silent ? styles.silent : styles.reporting}`} aria-hidden />
            <span className={styles.deviceName}>
              <strong>{beat.id}</strong>
              <span>{KIND_LABEL[beat.kind]}</span>
            </span>
            <span className={`${styles.deviceSeen} ${silent ? styles.silent : ""}`}>
              {beat.lastSeen ? (
                <time dateTime={new Date(beat.lastSeen).toISOString()} title={fmt.time(beat.lastSeen)}>
                  {silent ? "Silent · " : ""}
                  {formatAgo(now - beat.lastSeen)}
                </time>
              ) : (
                "Not heard since this page opened"
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function AlertsView() {
  const { activeFarmId, farm } = useSelectedFarm();
  const { fmt, prefs } = usePreferences();
  const timeWindow = TIME_WINDOWS[prefs.timeWindow];
  const [shown, setShown] = useState(PAGE_SIZE);
  // Remotely there are no device heartbeats yet: the latest sensor reading stands in
  const { lastUpdate } = useFarmTelemetry(activeFarmId);
  const { beats, now } = useDeviceHeartbeats();
  // From the farm's services: the orchestrator and the alert engine
  const farmAlerts = useFarmAlerts();

  // a new window, or another farm, starts at the first page
  useEffect(() => setShown(PAGE_SIZE), [prefs.timeWindow, activeFarmId]);

  const { open, earlier, inWindow } = useMemo(() => {
    const listed = farmAlerts ? listAlerts(farmAlerts) : [];
    // Alert times are the farm's clock, the window the browser's (there's no
    // clock sync), so open alerts never depend on it: they're always listed.
    // An alert counts for the window when it was raised or resolved in it.
    const from = now - timeWindow.ms;
    const touchesWindow = ({ alert, resolvedAt }: ListedAlert) => Math.max(alert.timestamp, resolvedAt ?? 0) >= from;
    return {
      open: listed.filter(isOpen),
      earlier: listed.filter((item) => !isOpen(item) && touchesWindow(item)),
      inWindow: listed.filter(touchesWindow).length,
    };
  }, [farmAlerts, now, timeWindow.ms]);

  const counts = {
    warning: open.filter(({ alert }) => alert.severity === "warning").length,
    critical: open.filter(({ alert }) => alert.severity === "critical").length,
  };
  const silent = beats?.filter((beat) => isSilent(beat, now)) ?? [];
  const silentNames =
    silent.length > NAMED_SILENT
      ? `${silent.slice(0, NAMED_SILENT).map((beat) => beat.id).join(", ")} and ${silent.length - NAMED_SILENT} more`
      : silent.map((beat) => beat.id).join(", ");

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
        <TimeWindowPicker />
      </div>

      <div className={styles.summaryGrid}>
        <article className={`glassPanel ${styles.summaryCard}`}>
          <span className={styles.summaryLabel}>Last {timeWindow.label}</span>
          <strong className={styles.summaryValue}>{inWindow}</strong>
          <span className={styles.summaryDetail}>Alerts raised or resolved</span>
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
        {beats ? (
          <article className={`glassPanel ${styles.summaryCard}`}>
            <span className={styles.summaryLabel}>Devices reporting</span>
            <strong className={`${styles.summaryValue} ${silent.length ? styles.silent : ""}`}>
              {beats.length - silent.length} / {beats.length}
            </strong>
            <span className={styles.summaryDetail}>
              {!beats.length ? "None heard from yet" : silent.length ? `Silent: ${silentNames}` : "Every device is reporting"}
            </span>
          </article>
        ) : (
          <article className={`glassPanel ${styles.summaryCard}`}>
            <span className={styles.summaryLabel}>Heartbeat</span>
            <strong className={styles.summaryValue} suppressHydrationWarning>
              {lastUpdate ? fmt.time(lastUpdate) : "Never"}
            </strong>
            <span className={styles.summaryDetail}>Last sensor heartbeat seen</span>
          </article>
        )}
      </div>

      <div className={styles.list}>
        {farmAlerts === null ? (
          <article className={`glassPanel ${styles.emptyState}`}>
            <strong>Alerts aren&apos;t available here yet.</strong>
            <span>They show on the farm&apos;s Wi-Fi.</span>
          </article>
        ) : open.length === 0 && earlier.length === 0 ? (
          <article className={`glassPanel ${styles.emptyState}`}>
            <strong>No alerts in the last {timeWindow.label}.</strong>
            <span>Nothing is open. Open alerts always show here, whatever the window.</span>
          </article>
        ) : (
          <>
            {open.length ? (
              <>
                <h2 className={styles.listTitle}>Open</h2>
                {open.map((listed) => (
                  <AlertCard key={listed.alert.alert_id} listed={listed} />
                ))}
              </>
            ) : null}
            <h2 className={styles.listTitle}>Last {timeWindow.label}</h2>
            {earlier.length ? (
              earlier.slice(0, shown).map((listed) => <AlertCard key={listed.alert.alert_id} listed={listed} />)
            ) : (
              <p className={styles.quiet}>Nothing else in the last {timeWindow.label}.</p>
            )}
            {earlier.length > shown ? (
              <button type="button" className={styles.more} onClick={() => setShown((count) => count + PAGE_SIZE)}>
                {earlier.length - shown > PAGE_SIZE
                  ? `Show ${PAGE_SIZE} more of ${earlier.length - shown}`
                  : `Show ${earlier.length - shown} more`}
              </button>
            ) : null}
          </>
        )}
      </div>

      {beats?.length ? (
        <div className={styles.list}>
          <h2 className={styles.listTitle}>Devices</h2>
          <DeviceList beats={beats} now={now} />
        </div>
      ) : null}
    </section>
  );
}
