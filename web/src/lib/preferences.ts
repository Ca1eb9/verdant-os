// Display preferences: how times and temperatures are shown.
// Stored per device (see PreferencesProvider); these helpers are pure.

export type TemperatureUnit = "C" | "F";
export type TimeFormat = "12h" | "24h";

export const TIME_ZONES = [
  { value: "local", label: "Browser time" },
  { value: "America/New_York", label: "Eastern (ET)" },
  { value: "America/Chicago", label: "Central (CT)" },
  { value: "America/Denver", label: "Mountain (MT)" },
  { value: "America/Los_Angeles", label: "Pacific (PT)" },
  { value: "UTC", label: "UTC" },
] as const;

export type TimeZoneSetting = (typeof TIME_ZONES)[number]["value"];

export interface Preferences {
  temperatureUnit: TemperatureUnit;
  timeFormat: TimeFormat;
  timeZone: TimeZoneSetting;
  showSeconds: boolean;
  /** Desktop sidebar state; changed from the sidebar itself */
  sidebarCollapsed: boolean;
}

export const DEFAULT_PREFERENCES: Preferences = {
  temperatureUnit: "C",
  timeFormat: "12h",
  timeZone: "local",
  showSeconds: true,
  sidebarCollapsed: false,
};

/** Keep only valid stored values; anything unknown falls back to its default */
export function normalizePreferences(raw: unknown): Preferences {
  const value = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const pick = <K extends keyof Preferences>(key: K, valid: (v: unknown) => boolean): Preferences[K] =>
    valid(value[key]) ? (value[key] as Preferences[K]) : DEFAULT_PREFERENCES[key];

  return {
    temperatureUnit: pick("temperatureUnit", (v) => v === "C" || v === "F"),
    timeFormat: pick("timeFormat", (v) => v === "12h" || v === "24h"),
    timeZone: pick("timeZone", (v) => TIME_ZONES.some((zone) => zone.value === v)),
    showSeconds: pick("showSeconds", (v) => typeof v === "boolean"),
    sidebarCollapsed: pick("sidebarCollapsed", (v) => typeof v === "boolean"),
  };
}

function zoneOptions(prefs: Preferences): Intl.DateTimeFormatOptions {
  return prefs.timeZone === "local" ? {} : { timeZone: prefs.timeZone, timeZoneName: "short" };
}

/** Date + time, e.g. "Sep 25, 8:05:21 PM" (adds "EDT" when a fixed zone is chosen) */
export function formatTime(value: string | number | Date, prefs: Preferences, options: { date?: boolean } = {}) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    ...(options.date === false ? {} : { month: "short", day: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
    ...(prefs.showSeconds ? { second: "2-digit" } : {}),
    hourCycle: prefs.timeFormat === "24h" ? "h23" : "h12",
    ...zoneOptions(prefs),
  }).format(date);
}

/** Short axis label for charts */
export function formatChartTick(value: string, prefs: Preferences, compact = false) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const zone = prefs.timeZone === "local" ? {} : { timeZone: prefs.timeZone };
  return new Intl.DateTimeFormat("en-US", {
    ...(compact ? { hour: "numeric" } : { month: "short", day: "numeric" }),
    hourCycle: prefs.timeFormat === "24h" ? "h23" : "h12",
    ...zone,
  }).format(date);
}

export function toDisplayTemp(celsius: number, unit: TemperatureUnit) {
  return unit === "F" ? (celsius * 9) / 5 + 32 : celsius;
}

export function temperatureLabel(unit: TemperatureUnit) {
  return unit === "F" ? "°F" : "°C";
}

/** e.g. "23.8 °C" or "74.8 °F" */
export function formatTemperature(celsius: number | null, prefs: Preferences, precision = 1) {
  if (celsius === null || !Number.isFinite(celsius)) return "No reading";
  const value = toDisplayTemp(celsius, prefs.temperatureUnit);
  return `${value.toFixed(precision)} ${temperatureLabel(prefs.temperatureUnit)}`;
}
