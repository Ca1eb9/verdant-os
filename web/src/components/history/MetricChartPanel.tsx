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
import { formatChartTick, formatMetric, formatTimestamp } from "@/lib/format";
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
  if (!active || !payload?.length || !label) {
    return null;
  }

  return (
    <div className={styles.tooltip}>
      <strong className={styles.tooltipHeader}>{formatTimestamp(label)}</strong>
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

  return (
    <article className={`glassPanel ${styles.chartPanel}`}>
      <div className={styles.chartHeader}>
        <div>
          <span className="eyebrow">Time-series analysis</span>
          <h2 className={styles.chartTitle}>{title}</h2>
        </div>
        <p className={styles.chartDescription}>{description}</p>
      </div>

      <div className={styles.chartBody}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data}>
            <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
            <XAxis
              dataKey="timestamp"
              axisLine={false}
              tickLine={false}
              minTickGap={24}
              tick={{ fill: "#8aa3bc", fontSize: 12 }}
              tickFormatter={(value) => formatChartTick(value, range !== "7d")}
            />
            <YAxis
              yAxisId="left"
              axisLine={false}
              tickLine={false}
              width={44}
              tick={{ fill: "#8aa3bc", fontSize: 12 }}
            />
            {hasRightAxis ? (
              <YAxis
                yAxisId="right"
                orientation="right"
                axisLine={false}
                tickLine={false}
                width={44}
                tick={{ fill: "#8aa3bc", fontSize: 12 }}
              />
            ) : null}
            <Tooltip content={<ChartTooltip series={series} />} />
            <Legend
              verticalAlign="top"
              align="right"
              iconType="circle"
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
                activeDot={{ r: 5, strokeWidth: 0, fill: item.color }}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </article>
  );
}
