// Time windows shared by the History and Alerts pages. Each window picks a
// sample step so charts stay at 60-170 points whatever the span.

export type TimeWindow = "15m" | "1h" | "6h" | "24h" | "7d";
// ticks fall between whole hours, so anything up to a day is labelled to the minute
export type TickStyle = "minute" | "day";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

export const TIME_WINDOWS: Record<TimeWindow, { label: string; ms: number; stepMs: number; tick: TickStyle }> = {
  "15m": { label: "15 minutes", ms: 15 * MINUTE, stepMs: 15 * SECOND, tick: "minute" },
  "1h": { label: "hour", ms: HOUR, stepMs: MINUTE, tick: "minute" },
  "6h": { label: "6 hours", ms: 6 * HOUR, stepMs: 5 * MINUTE, tick: "minute" },
  "24h": { label: "24 hours", ms: 24 * HOUR, stepMs: 15 * MINUTE, tick: "minute" },
  "7d": { label: "7 days", ms: 7 * 24 * HOUR, stepMs: HOUR, tick: "day" },
};

export const TIME_WINDOW_OPTIONS = Object.keys(TIME_WINDOWS) as TimeWindow[];

export function isTimeWindow(value: unknown): value is TimeWindow {
  return typeof value === "string" && value in TIME_WINDOWS;
}
