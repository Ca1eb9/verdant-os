"use client";

import { useMemo } from "react";
import { useSelectedFarm } from "@/components/farms/FarmContext";
import { NoFarmNotice } from "@/components/farms/NoFarmNotice";
import { MetricChartPanel, type MetricConfig } from "@/components/history/MetricChartPanel";
import { usePreferences } from "@/components/preferences/PreferencesProvider";
import { TimeWindowPicker } from "@/components/ui/TimeWindowPicker";
import { useShelfHistory } from "@/hooks/useShelfHistory";
import {
  MOCK_DATA_ENABLED,
  buildHistoricalSeries,
} from "@/lib/mock-data";
import { TIME_WINDOWS } from "@/lib/time-windows";
import styles from "@/components/history/HistoryView.module.css";

const HOUR_MS = 60 * 60 * 1000;

// series colours per theme (light uses deeper tones so lines read on white)
const SERIES_COLORS = {
  dark: { cyan: "#67dfff", teal: "#6ff7c3", amber: "#ffc45f", lime: "#d8ff72" },
  light: { cyan: "#0891b2", teal: "#059669", amber: "#d97706", lime: "#65a30d" },
} as const;

export function HistoryView() {
  const { activeFarmId, farm } = useSelectedFarm();
  const { fmt, prefs, theme } = usePreferences();
  const timeWindow = prefs.timeWindow;
  const color = SERIES_COLORS[theme];
  const DEGREE = fmt.tempUnit;

  // On FarmNet: the Pi's stored shelf readings, then those received since the
  // dashboard opened. Remote (Supabase) history comes with the remote source.
  const { points: livePoints, live, now } = useShelfHistory(timeWindow);

  // temperatures are stored in °C; convert once for display
  const data = useMemo(() => {
    if (!activeFarmId) return [];
    // mock history is hourly: at least two points, so even 15 minutes draws a line
    const series = MOCK_DATA_ENABLED
      ? buildHistoricalSeries(activeFarmId, Math.max(2, Math.ceil(TIME_WINDOWS[timeWindow].ms / HOUR_MS)))
      : livePoints;
    if (prefs.temperatureUnit === "C") return series;
    const toUnit = (celsius: number | null) => (celsius === null ? null : fmt.tempValue(celsius));
    return series.map((point) => ({
      ...point,
      air: { ...point.air, temperature: toUnit(point.air.temperature) },
      water: { ...point.water, temperature: toUnit(point.water.temperature) },
    }));
  }, [activeFarmId, fmt, livePoints, prefs.temperatureUnit, timeWindow]);

  // smallest y-axis spans are set in °C; a °F axis spans 9/5 as many degrees
  const degrees = (celsius: number) => (prefs.temperatureUnit === "F" ? (celsius * 9) / 5 : celsius);
  // one chart per measurement, each on its own axis: the climate pair, the reservoir pair, then light
  const metrics: MetricConfig[] = [
    {
      key: "air.temperature",
      title: "Air temperature",
      description: "At the shelf",
      color: color.cyan,
      unit: DEGREE,
      precision: 1,
      minSpan: degrees(2),
      showAverage: true,
    },
    {
      key: "air.humidity",
      title: "Humidity",
      description: "At the shelf",
      color: color.teal,
      unit: "%",
      precision: 0,
      minSpan: 10,
      showAverage: true,
    },
    {
      key: "water.temperature",
      title: "Water temperature",
      description: "In the nutrient reservoir",
      color: color.cyan,
      unit: DEGREE,
      precision: 1,
      minSpan: degrees(2),
      showAverage: true,
    },
    {
      key: "water.ph",
      title: "pH",
      description: "In the nutrient reservoir",
      color: color.lime,
      unit: "",
      precision: 2,
      minSpan: 0.5,
      showAverage: true,
    },
    // no average: the grow lights switch on and off, so a mean of the two says nothing
    {
      key: "light.lux",
      title: "Light",
      color: color.amber,
      unit: "lux",
      precision: 0,
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
                ? `Readings from ${farm.name}, updated as new ones arrive.`
                : `Review time-series performance for ${farm.name}.`}
            </p>
          </div>

          <TimeWindowPicker />
        </div>
      </header>

      {data.length === 0 ? (
        <div className={`glassPanel ${styles.emptyState}`} role="status">
          <strong>{live ? `No sensor readings in the last ${TIME_WINDOWS[timeWindow].label}.` : "No sensor history yet."}</strong>
          <span>
            {live
              ? `The charts fill as ${farm.name}'s shelf sensors report. A longer window shows earlier readings.`
              : `The dashboard doesn't read stored history for ${farm.name} yet; it will once the history feed is built.`}
          </span>
        </div>
      ) : null}

      <div className={styles.chartGrid}>
        {data.length > 0 &&
          metrics.map((metric) => <MetricChartPanel key={metric.key} metric={metric} data={data} timeWindow={timeWindow} end={now} />)}
      </div>
    </section>
  );
}
