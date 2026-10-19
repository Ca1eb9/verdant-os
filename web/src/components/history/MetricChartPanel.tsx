"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { usePreferences } from "@/components/preferences/PreferencesProvider";
import { average, formatMetric } from "@/lib/format";
import { TIME_WINDOWS, type TimeWindow } from "@/lib/time-windows";
import type { HistoryPoint } from "@/lib/types";
import styles from "@/components/history/HistoryView.module.css";

// Axis ticks are 44px wide: light readings run to five digits, so 16,500 shows as 17K
const AXIS_THOUSANDS = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 0 });
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
// Time ticks fall on round times, at the smallest of these steps that keeps about X_TICKS of them
// (few enough to fit, so a narrow phone hides every other one and the rest stay evenly spaced)
const TIME_STEPS_MS = [
  MINUTE_MS,
  5 * MINUTE_MS,
  15 * MINUTE_MS,
  30 * MINUTE_MS,
  HOUR_MS,
  2 * HOUR_MS,
  3 * HOUR_MS,
  6 * HOUR_MS,
  12 * HOUR_MS,
  DAY_MS,
  2 * DAY_MS,
];
const X_TICKS = 4;
// Room above and below the line, as a share of the axis span
const Y_PADDING = 0.1;
// Gaps between y-axis ticks, roughly this many per axis
const Y_TICKS = 4;
// Tick steps are one of these times a power of ten: 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10…
const NICE_STEPS = [1, 2, 2.5, 5, 10];
// Limit lines are context, not data: faint, under the reading's line
const LIMIT_OPACITY = 0.55;

/** One measurement: one chart, one axis */
export interface MetricConfig {
  /** Dotted path into a HistoryPoint, e.g. "air.temperature" */
  key: string;
  title: string;
  /** Small print under the title, only where it adds something */
  description?: string;
  color: string;
  unit: string;
  precision: number;
  /**
   * The smallest span the y-axis shows, so sensor noise on a steady reading
   * doesn't look like a swing. Unset: the axis starts at 0 (light, where 0 is off).
   */
  minSpan?: number;
  /** Show the average over the window, top right */
  showAverage?: boolean;
  /** The alert engine's metric for this chart, whose limits it draws */
  alertMetric?: string;
}

/** A metric's alert limits, in the chart's unit */
export interface ChartLimits {
  warning: [number, number];
  critical: [number, number];
}

interface MetricChartPanelProps {
  metric: MetricConfig;
  data: HistoryPoint[];
  timeWindow: TimeWindow;
  /** The window's end (now): the time axis always spans the whole window */
  end: number;
  /** Drawn as faint dashed lines; null when the alert engine's limits aren't known */
  limits: ChartLimits | null;
}

/** The metric's value at a point, from its dotted key */
function valueAt(point: HistoryPoint, key: string) {
  const value = key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], point);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Round times between start and end: whole minutes or hours, or local midnights for days */
function timeTicks(start: number, end: number) {
  const step = TIME_STEPS_MS.find((ms) => (end - start) / ms <= X_TICKS) ?? TIME_STEPS_MS[TIME_STEPS_MS.length - 1];
  const midnight = new Date(start);
  midnight.setHours(0, 0, 0, 0);
  const from = step >= DAY_MS ? midnight.getTime() + DAY_MS : Math.ceil(start / step) * step;
  const ticks: number[] = [];
  for (let tick = from; tick <= end; tick += step) ticks.push(tick);
  return ticks;
}

interface YAxisFit {
  domain: [number, number] | [number, "auto"];
  ticks?: number[];
  /** Decimals every tick shows, so 6.0 lines up with 6.2 */
  decimals: number;
}

/**
 * Fits the axis to the readings, at least minSpan tall with a little room above
 * and below, on round ticks. Without minSpan the library's axis from 0 is kept.
 */
function fitYAxis(values: number[], minSpan: number | undefined): YAxisFit {
  if (minSpan === undefined || !values.length) return { domain: [0, "auto"], decimals: 0 };
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = Math.max(high - low, minSpan) * (1 + 2 * Y_PADDING);
  const magnitude = 10 ** Math.floor(Math.log10(span / Y_TICKS));
  const step = magnitude * (NICE_STEPS.find((nice) => nice * magnitude >= span / Y_TICKS) ?? 10);
  const middle = (low + high) / 2;
  const first = Math.floor((middle - span / 2) / step);
  const last = Math.ceil((middle + span / 2) / step);
  const ticks = Array.from({ length: last - first + 1 }, (_, i) => Number(((first + i) * step).toFixed(6)));
  const decimals = Math.max(0, ...ticks.map((tick) => (String(tick).split(".")[1] ?? "").length));
  return { domain: [ticks[0], ticks[ticks.length - 1]], ticks, decimals };
}

function ChartTooltip({
  active,
  label,
  payload,
  metric,
}: {
  active?: boolean;
  label?: number;
  payload?: Array<{ value: number }>;
  metric: MetricConfig;
}) {
  const { fmt } = usePreferences();
  if (!active || !payload?.length || !label) {
    return null;
  }

  return (
    <div className={styles.tooltip}>
      <span className={styles.tooltipHeader}>{fmt.time(label)}</span>
      <strong>{formatMetric(Number(payload[0].value), metric.unit, metric.precision)}</strong>
    </div>
  );
}

export function MetricChartPanel({ data, end, limits, metric, timeWindow }: MetricChartPanelProps) {
  const values = data.map((point) => valueAt(point, metric.key)).filter((value): value is number => value !== null);
  // A time axis over the whole window: missing readings show as empty time,
  // not squeezed out, and "15m" always spans fifteen minutes
  const points = data.map((point) => ({ ...point, time: new Date(point.timestamp).getTime() }));
  // the clock ticks every few seconds: a reading newer than it still shows
  const axisEnd = Math.max(end, points.length ? points[points.length - 1].time : end);
  const start = axisEnd - TIME_WINDOWS[timeWindow].ms;
  const xTicks = timeTicks(start, axisEnd);
  // times of day, dates across a week
  const showTime = timeWindow !== "7d";
  // The warning band is always in view, so the line reads against its safe range; the
  // critical limits outside it only show once the readings come near them
  const yAxis = fitYAxis(limits && values.length ? [...values, ...limits.warning] : values, metric.minSpan);
  const limitLines = limits
    ? [
        ...limits.warning.map((y, i) => ({ y, kind: "Warning", color: "var(--amber)", above: i === 1 })),
        ...limits.critical.map((y, i) => ({ y, kind: "Critical", color: "var(--danger)", above: i === 1 })),
      ]
    : [];
  const formatTick = (value: number) =>
    Math.abs(value) >= 1000 ? AXIS_THOUSANDS.format(value) : value.toFixed(yAxis.decimals);
  const { fmt, theme } = usePreferences();
  const axis = theme === "light" ? { grid: "rgba(15,23,42,0.08)", tick: "#56667a" } : { grid: "rgba(255,255,255,0.06)", tick: "#8aa3bc" };

  return (
    <article className={`glassPanel ${styles.chartPanel}`}>
      <div className={styles.chartHeader}>
        <div className={styles.chartHeading}>
          <h2 className={styles.chartTitle}>
            {metric.title}
            {metric.unit ? <span className={styles.chartUnit}>{metric.unit}</span> : null}
          </h2>
          {metric.description ? <p className={styles.chartDescription}>{metric.description}</p> : null}
        </div>
        {metric.showAverage ? (
          <dl className={styles.chartStat} title={`Average over the last ${TIME_WINDOWS[timeWindow].label}`}>
            <dt>Avg</dt>
            <dd>{values.length ? formatMetric(average(values), metric.unit, metric.precision) : "—"}</dd>
          </dl>
        ) : null}
      </div>

      <div className={styles.chartBody}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
            <CartesianGrid stroke={axis.grid} vertical={false} />
            <XAxis
              dataKey="time"
              type="number"
              scale="time"
              domain={[start, axisEnd]}
              allowDataOverflow
              ticks={xTicks}
              axisLine={false}
              tickLine={false}
              minTickGap={24}
              tick={{ fill: axis.tick, fontSize: 12 }}
              tickFormatter={(value) => fmt.tick(value, showTime)}
            />
            <YAxis
              axisLine={false}
              tickLine={false}
              width={44}
              domain={yAxis.domain}
              ticks={yAxis.ticks}
              tick={{ fill: axis.tick, fontSize: 12 }}
              tickFormatter={formatTick}
            />
            {/* under the reading's line; a limit outside the axis isn't drawn */}
            {limitLines.map((limit) => (
              <ReferenceLine
                key={`${limit.kind}-${limit.y}`}
                y={limit.y}
                stroke={limit.color}
                strokeOpacity={LIMIT_OPACITY}
                strokeWidth={1}
                strokeDasharray="4 4"
                // one label per kind, on the upper line, at the oldest end where readings are fewest;
                // the colour names the lower one
                label={
                  limit.above
                    ? { value: limit.kind, position: "insideTopLeft", fill: limit.color, fillOpacity: LIMIT_OPACITY, fontSize: 10 }
                    : undefined
                }
              />
            ))}
            <Tooltip content={<ChartTooltip metric={metric} />} />
            <Line
              dataKey={metric.key}
              name={metric.title}
              type="monotone"
              stroke={metric.color}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
              activeDot={{ r: 5, strokeWidth: 0, fill: metric.color }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </article>
  );
}
