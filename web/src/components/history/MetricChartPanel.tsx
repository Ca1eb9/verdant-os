"use client";

import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { usePreferences } from "@/components/preferences/PreferencesProvider";
import { formatMetric } from "@/lib/format";
import type { HistoryPoint, HistoryRange } from "@/lib/types";
import styles from "@/components/history/HistoryView.module.css";

interface SeriesConfig {
  key: string;
  label: string;
  color: string;
  unit: string;
  precision: number;
  axisId?: "left" | "right";
}

interface MetricChartPanelProps {
  title: string;
  description: string;
  data: HistoryPoint[];
  range: HistoryRange;
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

export function MetricChartPanel({
  data,
  description,
  range,
  series,
  title,
}: MetricChartPanelProps) {
  const hasRightAxis = series.some((item) => item.axisId === "right");
  const { fmt, theme } = usePreferences();
  const axis = theme === "light" ? { grid: "rgba(15,23,42,0.08)", tick: "#56667a" } : { grid: "rgba(255,255,255,0.06)", tick: "#8aa3bc" };

  return (
    <article className={`glassPanel ${styles.chartPanel}`}>
      <div className={styles.chartHeader}>
        <h2 className={styles.chartTitle}>{title}</h2>
        <p className={styles.chartDescription}>{description}</p>
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
              tickFormatter={(value) => fmt.tick(value, range !== "7d")}
            />
            <YAxis
              yAxisId="left"
              axisLine={false}
              tickLine={false}
              width={44}
              tick={{ fill: axis.tick, fontSize: 12 }}
            />
            {hasRightAxis ? (
              <YAxis
                yAxisId="right"
                orientation="right"
                axisLine={false}
                tickLine={false}
                width={44}
                tick={{ fill: axis.tick, fontSize: 12 }}
              />
            ) : null}
            <Tooltip content={<ChartTooltip series={series} />} />
            <Legend
              verticalAlign="top"
              align="right"
              iconType="circle"
              iconSize={8}
              wrapperStyle={{ paddingBottom: 12, fontSize: 13 }}
              formatter={(value) => (
                <span className={styles.legendLabel}>
                  {series.find((item) => item.key === value)?.label ?? value}
                </span>
              )}
            />

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
