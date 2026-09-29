"use client";

import { usePreferences } from "@/components/preferences/PreferencesProvider";
import { TIME_WINDOW_OPTIONS } from "@/lib/time-windows";

/** 15m · 1h · 6h · 24h · 7d; the choice is shared by History and Alerts and remembered */
export function TimeWindowPicker() {
  const { prefs, setPref } = usePreferences();

  return (
    <div className="segmented" role="group" aria-label="Time window">
      {TIME_WINDOW_OPTIONS.map((option) => (
        <button
          key={option}
          type="button"
          className="segment"
          aria-pressed={prefs.timeWindow === option}
          onClick={() => setPref("timeWindow", option)}
        >
          {option}
        </button>
      ))}
    </div>
  );
}
