"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePreferences } from "@/components/preferences/PreferencesProvider";
import { TIME_ZONES, type TimeZoneSetting } from "@/lib/preferences";
import styles from "@/components/settings/SettingsView.module.css";

const SAMPLE_C = 23.8;

function Row({ id, label, hint, children }: { id: string; label: string; hint: string; children: ReactNode }) {
  return (
    <div className={styles.row}>
      <div className={styles.rowText}>
        <label htmlFor={id} className={styles.label}>
          {label}
        </label>
        <span className={styles.hint}>{hint}</span>
      </div>
      <div className={styles.control}>{children}</div>
    </div>
  );
}

export function SettingsView() {
  const { prefs, setPref, reset, fmt } = usePreferences();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <section className="pageSection">
      <header className={styles.header}>
        <span className="eyebrow">Preferences</span>
        <h1 className="pageTitle">Settings</h1>
        <p className="pageLead">How times and readings are shown. Saved on this device.</p>
      </header>

      <div className={`glassPanel ${styles.panel}`}>
        <h2 className={styles.groupTitle}>Display</h2>

        <Row id="temperature-unit" label="Temperature" hint="Sensor readings and history charts.">
          <div className="segmented" role="group" id="temperature-unit" aria-label="Temperature unit">
            {(["C", "F"] as const).map((unit) => (
              <button
                key={unit}
                type="button"
                className="segment"
                aria-pressed={prefs.temperatureUnit === unit}
                onClick={() => setPref("temperatureUnit", unit)}
              >
                {unit === "C" ? "°C" : "°F"}
              </button>
            ))}
          </div>
        </Row>

        <Row id="time-format" label="Time format" hint="Used for every timestamp in the app.">
          <div className="segmented" role="group" id="time-format" aria-label="Time format">
            {(["12h", "24h"] as const).map((format) => (
              <button
                key={format}
                type="button"
                className="segment"
                aria-pressed={prefs.timeFormat === format}
                onClick={() => setPref("timeFormat", format)}
              >
                {format === "12h" ? "12-hour" : "24-hour"}
              </button>
            ))}
          </div>
        </Row>

        <Row id="time-zone" label="Time zone" hint="Browser time follows this device's clock.">
          <select
            id="time-zone"
            className="controlSelect"
            value={prefs.timeZone}
            onChange={(event) => setPref("timeZone", event.target.value as TimeZoneSetting)}
          >
            {TIME_ZONES.map((zone) => (
              <option key={zone.value} value={zone.value}>
                {zone.label}
              </option>
            ))}
          </select>
        </Row>

        <Row id="show-seconds" label="Show seconds" hint="Include seconds in times.">
          <button
            id="show-seconds"
            type="button"
            role="switch"
            aria-checked={prefs.showSeconds}
            className={styles.switch}
            onClick={() => setPref("showSeconds", !prefs.showSeconds)}
          >
            <span className={styles.knob} />
          </button>
        </Row>

        <div className={styles.footer}>
          <p className={styles.preview} aria-live="polite">
            <span className={styles.previewLabel}>Preview</span>
            <span suppressHydrationWarning>{fmt.time(now)}</span>
            <span aria-hidden>·</span>
            <span>{fmt.temp(SAMPLE_C)}</span>
          </p>
          <button type="button" className={styles.reset} onClick={reset}>
            Reset to defaults
          </button>
        </div>
      </div>
    </section>
  );
}
