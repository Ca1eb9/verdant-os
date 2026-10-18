"use client";

import { useMemo } from "react";
import { useSelectedFarm } from "@/components/farms/FarmContext";
import { NoFarmNotice } from "@/components/farms/NoFarmNotice";
import { MetricChartPanel } from "@/components/history/MetricChartPanel";
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
  const { points: livePoints, live } = useShelfHistory(timeWindow);

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

  const charts = [
    {
      title: "Air Climate",
      description: "Temperature and humidity over the selected window.",
      series: [
        {
          key: "air.temperature",
          showAverage: true,
          label: "Air Temp",
          color: color.cyan,
          unit: DEGREE,
          precision: 1,
          axisId: "left" as const,
        },
        {
          key: "air.humidity",
          showAverage: true,
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
          showAverage: true,
          label: "Water Temp",
          color: color.cyan,
          unit: DEGREE,
          precision: 1,
          axisId: "left" as const,
        },
        {
          key: "water.ph",
          showAverage: true,
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
      // no average: the grow lights switch on and off, so a mean of the two says nothing
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
        {data.length > 0 && charts.map((chart) => (
          <MetricChartPanel
            key={chart.title}
            title={chart.title}
            description={chart.description}
            data={data}
            timeWindow={timeWindow}
            series={chart.series}
          />
        ))}
      </div>
    </section>
  );
}
