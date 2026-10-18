"use client";

import { usePreferences } from "@/components/preferences/PreferencesProvider";
import { TIME_WINDOW_OPTIONS, TIME_WINDOWS } from "@/lib/time-windows";
import styles from "@/components/ui/TimeWindowPicker.module.css";

/** 15m · 1h · 6h · 24h · 7d: one choice for History and Alerts, remembered on this device */
export function TimeWindowPicker() {
  const { prefs, setPref } = usePreferences();

  return (
    <div className={styles.picker}>
      <span className={styles.label} id="time-window-label">
        Window
      </span>
      <div className={styles.row} role="group" aria-labelledby="time-window-label">
        {TIME_WINDOW_OPTIONS.map((option) => (
          <button
            key={option}
            type="button"
            className={styles.option}
            aria-pressed={prefs.timeWindow === option}
            aria-label={`Last ${TIME_WINDOWS[option].label}`}
            onClick={() => setPref("timeWindow", option)}
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  );
}
