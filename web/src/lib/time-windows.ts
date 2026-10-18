// The time windows of the History and Alerts pages. One choice for both
// pages, kept with the other display preferences (lib/preferences.ts).

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** label completes "in the last …" */
export const TIME_WINDOWS = {
  "15m": { label: "15 minutes", ms: 15 * MINUTE_MS },
  "1h": { label: "hour", ms: HOUR_MS },
  "6h": { label: "6 hours", ms: 6 * HOUR_MS },
  "24h": { label: "24 hours", ms: 24 * HOUR_MS },
  // the Pi's Dashboard API keeps a week of shelf readings
  "7d": { label: "7 days", ms: 7 * 24 * HOUR_MS },
} as const;

export type TimeWindow = keyof typeof TIME_WINDOWS;

export const TIME_WINDOW_OPTIONS = Object.keys(TIME_WINDOWS) as TimeWindow[];

export function isTimeWindow(value: unknown): value is TimeWindow {
  return typeof value === "string" && Object.hasOwn(TIME_WINDOWS, value);
}
