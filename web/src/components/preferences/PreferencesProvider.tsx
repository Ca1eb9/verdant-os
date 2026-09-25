"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  DEFAULT_PREFERENCES,
  formatChartTick,
  formatTemperature,
  formatTime,
  normalizePreferences,
  temperatureLabel,
  toDisplayTemp,
  type Preferences,
} from "@/lib/preferences";

export const PREFERENCES_KEY = "verdantos:preferences";

interface PreferencesContextValue {
  prefs: Preferences;
  /** Stored values have loaded (false during the server render and first paint) */
  ready: boolean;
  setPref: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void;
  reset: () => void;
  fmt: {
    time: (value: string | number | Date, options?: { date?: boolean }) => string;
    temp: (celsius: number | null, precision?: number) => string;
    tempValue: (celsius: number) => number;
    tempUnit: string;
    tick: (value: string, compact?: boolean) => string;
  };
}

const PreferencesContext = createContext<PreferencesContextValue | null>(null);

function readStored(): Preferences {
  try {
    const raw = window.localStorage.getItem(PREFERENCES_KEY);
    return normalizePreferences(raw ? JSON.parse(raw) : {});
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

function writeStored(prefs: Preferences) {
  try {
    window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify(prefs));
  } catch {
    // storage blocked: settings last for this visit only
  }
}

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<Preferences>(DEFAULT_PREFERENCES);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setPrefs(readStored());
    setReady(true);
  }, []);

  // the inline script in layout.tsx set this before paint; only take over once stored values are in
  useEffect(() => {
    if (ready) document.documentElement.dataset.sidebar = prefs.sidebarCollapsed ? "collapsed" : "expanded";
  }, [prefs.sidebarCollapsed, ready]);

  const setPref = useCallback(<K extends keyof Preferences>(key: K, value: Preferences[K]) => {
    setPrefs((current) => {
      const next = { ...current, [key]: value };
      writeStored(next);
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    setPrefs((current) => {
      // keep the sidebar where the user left it
      const next = { ...DEFAULT_PREFERENCES, sidebarCollapsed: current.sidebarCollapsed };
      writeStored(next);
      return next;
    });
  }, []);

  const value = useMemo<PreferencesContextValue>(
    () => ({
      prefs,
      ready,
      setPref,
      reset,
      fmt: {
        // times depend on the viewer's zone, so they render once settings are loaded
        time: (v, options) => (ready ? formatTime(v, prefs, options) : "—"),
        temp: (c, precision = 1) => formatTemperature(c, prefs, precision),
        tempValue: (c) => toDisplayTemp(c, prefs.temperatureUnit),
        tempUnit: temperatureLabel(prefs.temperatureUnit),
        tick: (v, compact = false) => (ready ? formatChartTick(v, prefs, compact) : ""),
      },
    }),
    [prefs, ready, reset, setPref],
  );

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export function usePreferences() {
  const context = useContext(PreferencesContext);
  if (!context) throw new Error("usePreferences must be used within a PreferencesProvider");
  return context;
}
