"use client";

import { useMemo, useState } from "react";
import { useSelectedFarm } from "@/components/farms/FarmContext";
import { MetricChartPanel } from "@/components/history/MetricChartPanel";
import {
  FARMS,
  HISTORY_RANGE_HOURS,
  buildHistoricalSeries,
} from "@/lib/mock-data";
import {
  average,
  formatInteger,
  formatMetric,
  maximum,
  minimum,
} from "@/lib/format";
import type { HistoryRange } from "@/lib/types";
import styles from "@/components/history/HistoryView.module.css";

const rangeOptions: HistoryRange[] = ["24h", "72h", "7d"];
const DEGREE_C = "\u00B0C";
const RANGE_ARROW = "\u2192";
const MID_DOT = "\u00B7";

export function HistoryView() {
  const { activeFarmId, farm, setActiveFarmId } = useSelectedFarm();
  const [range, setRange] = useState<HistoryRange>("72h");

  const data = useMemo(
    () => buildHistoricalSeries(activeFarmId, HISTORY_RANGE_HOURS[range]),
    [activeFarmId, range],
  );

  const summary = useMemo(() => {
    const airTemp = data.map((point) => point.air.temperature);
    const humidity = data.map((point) => point.air.humidity);
    const pressure = data.map((point) => point.air.pressure);
    const waterTemp = data.map((point) => point.water.temperature);
    const waterPh = data.map((point) => point.water.ph);
    const waterEc = data.map((point) => point.water.ec);
    const waterLevel = data.map((point) => point.water.level);
    const hours = HISTORY_RANGE_HOURS[range];

    return [
      {
        label: "Climate average",
        value: `${formatMetric(average(airTemp), DEGREE_C, 1)} ${MID_DOT} ${formatMetric(average(humidity), "%", 0)}`,
        detail: "Average air temperature and humidity",
      },
      {
        label: "Pressure band",
        value: `${formatMetric(minimum(pressure), "hPa", 1)} ${RANGE_ARROW} ${formatMetric(maximum(pressure), "hPa", 1)}`,
        detail: "Observed atmospheric swing",
      },
      {
        label: "Nutrient chemistry",
        value: `${formatMetric(average(waterPh), "", 2)} pH ${MID_DOT} ${formatMetric(maximum(waterEc), "mS/cm", 2)}`,
        detail: "Average pH and peak EC",
      },
      {
        label: "Reservoir reserve",
        value: `${formatMetric(average(waterTemp), DEGREE_C, 1)} ${MID_DOT} ${formatMetric(minimum(waterLevel), "%", 0)}`,
        detail: "Average water temp and minimum level",
      },
      {
        label: "Dataset density",
        value: `${formatInteger(data.length)} pts ${MID_DOT} ${formatMetric(data.length / hours, "pts/hr", 2)}`,
        detail: "Captured points inside the selected time window",
      },
    ];
  }, [data, range]);

  const charts = [
    {
      title: "Air Climate",
      description: "Temperature and humidity over the selected operating window.",
      series: [
        {
          key: "air.temperature",
          label: "Air Temp",
          color: "#67dfff",
          unit: DEGREE_C,
          precision: 1,
          axisId: "left" as const,
        },
        {
          key: "air.humidity",
          label: "Humidity",
          color: "#6ff7c3",
          unit: "%",
          precision: 0,
          axisId: "right" as const,
        },
      ],
    },
    {
      title: "Atmospheric Pressure",
      description: "Pressure shifts that influence airflow stability and climate control.",
      series: [
        {
          key: "air.pressure",
          label: "Pressure",
          color: "#ffc45f",
          unit: "hPa",
          precision: 1,
          axisId: "left" as const,
        },
      ],
    },
    {
      title: "Water Loop",
      description: "Reservoir thermal response and fill level across the circulation loop.",
      series: [
        {
          key: "water.temperature",
          label: "Water Temp",
          color: "#67dfff",
          unit: DEGREE_C,
          precision: 1,
          axisId: "left" as const,
        },
        {
          key: "water.level",
          label: "Water Level",
          color: "#6ff7c3",
          unit: "%",
          precision: 0,
          axisId: "right" as const,
        },
      ],
    },
    {
      title: "Water Chemistry",
      description: "pH and EC tracking for nutrient recipe verification.",
      series: [
        {
          key: "water.ph",
          label: "pH",
          color: "#d8ff72",
          unit: "",
          precision: 2,
          axisId: "left" as const,
        },
        {
          key: "water.ec",
          label: "EC",
          color: "#67dfff",
          unit: "mS/cm",
          precision: 2,
          axisId: "right" as const,
        },
      ],
    },
    {
      title: "Canopy Light",
      description: "PPFD history for fixture output and photoperiod consistency.",
      series: [
        {
          key: "light.ppfd",
          label: "PPFD",
          color: "#d8ff72",
          unit: "PPFD",
          precision: 0,
          axisId: "left" as const,
        },
      ],
    },
  ];

  return (
    <section className="pageSection">
      <div className={`glassPanel ${styles.hero}`}>
        <div className={styles.toolbar}>
          <div className={styles.heading}>
            <span className="eyebrow">Historical analytics</span>
            <h1 className="pageTitle">Sensor History</h1>
            <p className="pageLead">Review time-series performance for {farm.name}.</p>
          </div>

          <div className={styles.controlStack}>
            <label className={styles.controlGroup}>
              <span className={styles.metaLabel}>Farm</span>
              <select
                className="controlSelect"
                value={activeFarmId}
                onChange={(event) => setActiveFarmId(event.target.value)}
                aria-label="History farm selector"
              >
                {FARMS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </select>
            </label>

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
      </div>

      <div className={styles.chartGrid}>
        {charts.map((chart) => (
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
