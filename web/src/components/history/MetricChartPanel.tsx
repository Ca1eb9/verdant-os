"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
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
const formatAxisTick = (value: number) => (Math.abs(value) >= 1000 ? AXIS_THOUSANDS.format(value) : String(value));
const DAY_MS = 24 * 60 * 60 * 1000;

interface SeriesConfig {
  key: string;
  label: string;
  color: string;
  unit: string;
  precision: number;
  axisId?: "left" | "right";
  /** Show the series' average over the window in the chart's header */
  showAverage?: boolean;
}

interface MetricChartPanelProps {
  title: string;
  description: string;
  data: HistoryPoint[];
  timeWindow: TimeWindow;
  series: SeriesConfig[];
}

function ChartTooltip({
  active,
  label,
  payload,
  series,
}: {
  active?: boolean;
  label?: string;
  payload?: Array<{ color: string; dataKey: string; value: number }>;
  series: SeriesConfig[];
}) {
  const { fmt } = usePreferences();
  if (!active || !payload?.length || !label) {
    return null;
  }

  return (
    <div className={styles.tooltip}>
      <strong className={styles.tooltipHeader}>{fmt.time(label)}</strong>
      {payload.map((item) => {
        const config = series.find((entry) => entry.key === item.dataKey);

        if (!config) {
          return null;
        }

        return (
          <div key={item.dataKey} className={styles.tooltipRow}>
            <span
              className={styles.tooltipSwatch}
              style={{ backgroundColor: item.color }}
              aria-hidden
            />
            <span>{config.label}</span>
            <strong>{formatMetric(Number(item.value), config.unit, config.precision)}</strong>
          </div>
        );
      })}
    </div>
  );
}

/** A series' value at a point, from its dotted key (e.g. "air.temperature") */
function valueAt(point: HistoryPoint, key: string) {
  const value = key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], point);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Each averaged series' mean over the window, top right of the chart; "—" when it never read */
function ChartAverages({ data, series, timeWindow }: { data: HistoryPoint[]; series: SeriesConfig[]; timeWindow: TimeWindow }) {
  const averaged = series.filter((item) => item.showAverage);
  if (!averaged.length) return null;

  return (
    <dl className={styles.chartStats} title={`Averages over the last ${TIME_WINDOWS[timeWindow].label}`}>
      {averaged.map((item) => {
        const values = data.map((point) => valueAt(point, item.key)).filter((value): value is number => value !== null);
        return (
          <div key={item.key} className={styles.chartStat}>
            <dt>
              <i className={styles.legendSwatch} style={{ backgroundColor: item.color }} aria-hidden />
              Avg {item.label}
            </dt>
            <dd>{values.length ? formatMetric(average(values), item.unit, item.precision) : "—"}</dd>
          </div>
        );
      })}
    </dl>
  );
}

/** One axis's series names, with their units, on that axis's side of the chart */
function AxisLegend({ series, side }: { series: SeriesConfig[]; side: "left" | "right" }) {
  return (
    <div className={`${styles.axisLegendGroup} ${side === "right" ? styles.axisLegendRight : ""}`}>
      {series.map((item) => (
        <span key={item.key} className={styles.legendLabel}>
          <i className={styles.legendSwatch} style={{ backgroundColor: item.color }} aria-hidden />
          {item.label}
          {item.unit ? ` (${item.unit})` : ""}
        </span>
      ))}
    </div>
  );
}

export function MetricChartPanel({
  data,
  description,
  series,
  timeWindow,
  title,
}: MetricChartPanelProps) {
  const leftSeries = series.filter((item) => (item.axisId ?? "left") === "left");
  const rightSeries = series.filter((item) => item.axisId === "right");
  const hasRightAxis = rightSeries.length > 0;
  // times of day, unless the points cover more than a day of the 7-day window
  const spanMs = data.length ? new Date(data[data.length - 1].timestamp).getTime() - new Date(data[0].timestamp).getTime() : 0;
  const showTime = timeWindow !== "7d" || spanMs < DAY_MS;
  const { fmt, theme } = usePreferences();
  const axis = theme === "light" ? { grid: "rgba(15,23,42,0.08)", tick: "#56667a" } : { grid: "rgba(255,255,255,0.06)", tick: "#8aa3bc" };

  return (
    <article className={`glassPanel ${styles.chartPanel}`}>
      <div className={styles.chartHeader}>
        <div className={styles.chartHeading}>
          <h2 className={styles.chartTitle}>{title}</h2>
          <p className={styles.chartDescription}>{description}</p>
        </div>
        <ChartAverages data={data} series={series} timeWindow={timeWindow} />
      </div>

      <div className={styles.axisLegend}>
        <AxisLegend series={leftSeries} side="left" />
        {hasRightAxis ? <AxisLegend series={rightSeries} side="right" /> : null}
      </div>

      <div className={styles.chartBody}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -8 }}>
            <CartesianGrid stroke={axis.grid} vertical={false} />
            <XAxis
              dataKey="timestamp"
              axisLine={false}
              tickLine={false}
              minTickGap={24}
              tick={{ fill: axis.tick, fontSize: 12 }}
              tickFormatter={(value) => fmt.tick(value, showTime)}
            />
            <YAxis
              yAxisId="left"
              axisLine={false}
              tickLine={false}
              width={44}
              tick={{ fill: axis.tick, fontSize: 12 }}
              tickFormatter={formatAxisTick}
            />
            {hasRightAxis ? (
              <YAxis
                yAxisId="right"
                orientation="right"
                axisLine={false}
                tickLine={false}
                width={44}
                tick={{ fill: axis.tick, fontSize: 12 }}
                tickFormatter={formatAxisTick}
              />
            ) : null}
            <Tooltip content={<ChartTooltip series={series} />} />

            {series.map((item) => (
              <Line
                key={item.key}
                dataKey={item.key}
                name={item.key}
                yAxisId={item.axisId ?? "left"}
                type="monotone"
                stroke={item.color}
                strokeWidth={2.5}
                dot={false}
                isAnimationActive={false}
                activeDot={{ r: 5, strokeWidth: 0, fill: item.color }}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </article>
  );
}
