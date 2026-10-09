"use client";

import { useMemo, useState } from "react";
import { useSelectedFarm } from "@/components/farms/FarmContext";
import { NoFarmNotice } from "@/components/farms/NoFarmNotice";
import { MetricChartPanel } from "@/components/history/MetricChartPanel";
import { usePreferences } from "@/components/preferences/PreferencesProvider";
import { useShelfHistory } from "@/hooks/useShelfHistory";
import {
  HISTORY_RANGE_HOURS,
  MOCK_DATA_ENABLED,
  buildHistoricalSeries,
} from "@/lib/mock-data";
import {
  average,
  formatMetric,
  maximum,
  minimum,
} from "@/lib/format";
import type { HistoryRange } from "@/lib/types";
import styles from "@/components/history/HistoryView.module.css";

const rangeOptions: HistoryRange[] = ["24h", "72h", "7d"];

// series colours per theme (light uses deeper tones so lines read on white)
const SERIES_COLORS = {
  dark: { cyan: "#67dfff", teal: "#6ff7c3", amber: "#ffc45f", lime: "#d8ff72" },
  light: { cyan: "#0891b2", teal: "#059669", amber: "#d97706", lime: "#65a30d" },
} as const;
const RANGE_ARROW = "\u2192";
const MID_DOT = "\u00B7";

export function HistoryView() {
  const { activeFarmId, farm } = useSelectedFarm();
  const [range, setRange] = useState<HistoryRange>("72h");
  const { fmt, prefs, theme } = usePreferences();
  const color = SERIES_COLORS[theme];
  const DEGREE = fmt.tempUnit;

  // On FarmNet: the shelf readings received since the dashboard opened. Stored
  // history (Dashboard API / Supabase) comes with the dashboard data-flow work.
  const { points: livePoints, live } = useShelfHistory(range);

  // temperatures are stored in °C; convert once for display
  const data = useMemo(() => {
    if (!activeFarmId) return [];
    const series = MOCK_DATA_ENABLED ? buildHistoricalSeries(activeFarmId, HISTORY_RANGE_HOURS[range]) : livePoints;
    if (prefs.temperatureUnit === "C") return series;
    const toUnit = (celsius: number | null) => (celsius === null ? null : fmt.tempValue(celsius));
    return series.map((point) => ({
      ...point,
      air: { ...point.air, temperature: toUnit(point.air.temperature) },
      water: { ...point.water, temperature: toUnit(point.water.temperature) },
    }));
  }, [activeFarmId, fmt, livePoints, prefs.temperatureUnit, range]);

  const summary = useMemo(() => {
    if (!data.length) return [];
    // a sensor that never read in the range shows "No reading"
    const read = (values: (number | null)[]) => values.filter((value): value is number => value !== null);
    const airTemp = read(data.map((point) => point.air.temperature));
    const humidity = read(data.map((point) => point.air.humidity));
    const waterTemp = read(data.map((point) => point.water.temperature));
    const waterPh = read(data.map((point) => point.water.ph));
    const lux = read(data.map((point) => point.light.lux));
    const metric = (values: number[], pick: (values: number[]) => number, unit: string, precision: number) =>
      values.length ? formatMetric(pick(values), unit, precision) : "No reading";

    return [
      {
        label: "Climate average",
        value: `${metric(airTemp, average, DEGREE, 1)} ${MID_DOT} ${metric(humidity, average, "%", 0)}`,
        detail: "Average air temperature and humidity",
      },
      {
        label: "Reservoir",
        value: `${metric(waterTemp, average, DEGREE, 1)} ${MID_DOT} ${metric(waterPh, average, "pH", 2)}`,
        detail: "Average water temperature and pH",
      },
      {
        label: "Light range",
        value: lux.length ? `${metric(lux, minimum, "lux", 0)} ${RANGE_ARROW} ${metric(lux, maximum, "lux", 0)}` : "No reading",
        detail: "Lowest and highest light reading",
      },
    ];
  }, [DEGREE, data]);

  const charts = [
    {
      title: "Air Climate",
      description: "Temperature and humidity over the selected operating window.",
      series: [
        {
          key: "air.temperature",
          label: "Air Temp",
          color: color.cyan,
          unit: DEGREE,
          precision: 1,
          axisId: "left" as const,
        },
        {
          key: "air.humidity",
          label: "Humidity",
          color: color.teal,
          unit: "%",
          precision: 0,
          axisId: "right" as const,
        },
      ],
    },
    {
      title: "Reservoir",
      description: "Water temperature and pH of the nutrient reservoir.",
      series: [
        {
          key: "water.temperature",
          label: "Water Temp",
          color: color.cyan,
          unit: DEGREE,
          precision: 1,
          axisId: "left" as const,
        },
        {
          key: "water.ph",
          label: "pH",
          color: color.lime,
          unit: "",
          precision: 2,
          axisId: "right" as const,
        },
      ],
    },
    {
      title: "Light",
      description: "Light at the shelf, for spotting lights that are off or dimming.",
      series: [
        {
          key: "light.lux",
          label: "Light",
          color: color.amber,
          unit: "lux",
          precision: 0,
          axisId: "left" as const,
        },
      ],
    },
  ];

  if (!farm) return <NoFarmNotice title="Historical analytics" />;

  return (
    <section className="pageSection">
      <header className={styles.hero}>
        <div className={styles.toolbar}>
          <div className={styles.heading}>
            <span className="eyebrow">Historical analytics</span>
            <h1 className="pageTitle">Sensor History</h1>
            <p className="pageLead">
              {live
                ? `Readings from ${farm.name} since this dashboard opened. Earlier history isn't loaded yet.`
                : `Review time-series performance for ${farm.name}.`}
            </p>
          </div>

          <div className={styles.controlStack}>
            <div className={styles.controlGroup}>
              <span className={styles.metaLabel}>Window</span>
              <div className={styles.rangeRow}>
                {rangeOptions.map((option) => (
                  <button
                    key={option}
                    type="button"
                    className={`${styles.rangeButton} ${range === option ? styles.rangeActive : ""}`}
                    onClick={() => setRange(option)}
                  >
                    {option}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className={styles.summaryGrid}>
          {summary.map((item) => (
            <article key={item.label} className={styles.summaryCard}>
              <span className={styles.summaryLabel}>{item.label}</span>
              <strong className={styles.summaryValue}>{item.value}</strong>
              <span className={styles.summaryDetail}>{item.detail}</span>
            </article>
          ))}
        </div>
      </header>

      {data.length === 0 ? (
        <div className={`glassPanel ${styles.emptyState}`} role="status">
          <strong>No sensor history yet.</strong>
          <span>
            {live
              ? `The charts fill as ${farm.name}'s shelf sensors report.`
              : `The dashboard doesn't read stored history for ${farm.name} yet; it will once the history feed is built.`}
          </span>
        </div>
      ) : null}

      <div className={styles.chartGrid}>
        {data.length > 0 && charts.map((chart) => (
          <MetricChartPanel
            key={chart.title}
            title={chart.title}
            description={chart.description}
            data={data}
            range={range}
            series={chart.series}
          />
        ))}
      </div>
    </section>
  );
}
