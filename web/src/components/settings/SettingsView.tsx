"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePreferences } from "@/components/preferences/PreferencesProvider";
import { TIME_ZONES, type ThemePreference, type TimeZoneSetting } from "@/lib/preferences";
import styles from "@/components/settings/SettingsView.module.css";

const SAMPLE_C = 23.8;

const THEMES: { value: ThemePreference; label: string; icon: ReactNode }[] = [
  {
    value: "system",
    label: "System",
    icon: (
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
        <rect x="1.5" y="2.5" width="13" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <path d="M5.5 14h5M8 11.5V14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    value: "light",
    label: "Light",
    icon: (
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
        <circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <path
          d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
  {
    value: "dark",
    label: "Dark",
    icon: (
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
        <path d="M13.5 9.6A5.8 5.8 0 0 1 6.4 2.5a5.8 5.8 0 1 0 7.1 7.1Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      </svg>
    ),
  },
];

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
  const { prefs, setPref, reset, fmt, theme } = usePreferences();
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
        <h2 className={styles.groupTitle}>Appearance</h2>

        <Row
          id="theme"
          label="Theme"
          hint={prefs.theme === "system" ? `Follows your device (currently ${theme}).` : "Overrides your device setting."}
        >
          <div className="segmented" role="group" id="theme" aria-label="Theme">
            {THEMES.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`segment ${styles.iconSegment}`}
                aria-pressed={prefs.theme === option.value}
                onClick={() => setPref("theme", option.value)}
              >
                {option.icon}
                {option.label}
              </button>
            ))}
          </div>
        </Row>

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
