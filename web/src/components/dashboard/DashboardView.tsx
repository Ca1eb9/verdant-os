"use client";

import type { CSSProperties } from "react";
import { useEffect, useMemo, useState } from "react";
import { RobotsCard } from "@/components/dashboard/RobotsCard";
import { SensorCard } from "@/components/dashboard/SensorCard";
import { useSelectedFarm } from "@/components/farms/FarmContext";
import { NoFarmNotice } from "@/components/farms/NoFarmNotice";
import { useFarmTelemetry } from "@/hooks/useFarmTelemetry";
import { usePreferences } from "@/components/preferences/PreferencesProvider";
import { formatMetric } from "@/lib/format";
import styles from "@/components/dashboard/DashboardView.module.css";

const AIR_FALLBACK = "\uD83C\uDF2C\uFE0F";
const WATER_FALLBACK = "\uD83D\uDCA7";
const LIGHT_FALLBACK = "\uD83D\uDCA1";

// The reservoir has a float switch, not a gauge: the tank drawing shows above or below it
const RESERVOIR_FILL_OK = 72;
const RESERVOIR_FILL_LOW = 18;

function formatOptionalMetric(value: number | null, unit: string, precision = 1) {
  return value === null ? "No reading" : formatMetric(value, unit, precision);
}

const STATUS_LABEL = { live: "Live feed", stale: "Stale snapshot", waiting: "Waiting for data" };

export function DashboardView() {
  const { farm } = useSelectedFarm();
  const { fmt } = usePreferences();
  // readings load in the browser; the prerendered page shows placeholders instead
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const { reading, lastUpdate, liveStatus } = useFarmTelemetry(farm?.id ?? null);

  const airTemperature = reading?.airTemperature ?? null;
  const humidity = reading?.humidity ?? null;
  const pressure = reading?.pressure ?? null;
  const waterTemperature = reading?.waterTemperature ?? null;
  const waterPh = reading?.ph ?? null;
  const waterEc = reading?.ec ?? null;
  const lightPpfd = reading?.ppfd ?? null;
  const waterLevelOk = reading?.waterLevelOk ?? null;
  const reservoirLevel = waterLevelOk === null ? 0 : waterLevelOk ? RESERVOIR_FILL_OK : RESERVOIR_FILL_LOW;
  const waterLevelText =
    reading?.waterLevelText ??
    (waterLevelOk === null ? "No reading" : waterLevelOk ? "Liquid detected" : "No liquid detected");

  const sensorCards = useMemo(
    () => [
      {
        title: "Air",
        icon: "/images/air-icon.svg",
        fallback: AIR_FALLBACK,
        accent: "cyan" as const,
        heroLabel: "Air Temperature",
        heroValue: fmt.temp(airTemperature, 1),
        metrics: [
          {
            label: "Humidity",
            value: formatOptionalMetric(humidity, "%", 0),
            tone: "stable" as const,
          },
          {
            label: "Pressure",
            value: formatOptionalMetric(pressure, "hPa", 1),
            tone: "focus" as const,
          },
        ],
      },
      {
        title: "Water",
        icon: "/images/water-icon.svg",
        fallback: WATER_FALLBACK,
        accent: "teal" as const,
        heroLabel: "Water Temperature",
        heroValue: fmt.temp(waterTemperature, 1),
        visual: (
          <div
            className={styles.waterChamber}
            suppressHydrationWarning
            style={{ "--reservoir-level": `${reservoirLevel}%` } as CSSProperties}
          >
            <div className={styles.chamberHeader}>
              <span>Reservoir volume</span>
              <div
                className={`${styles.reservoirStatus} ${
                  waterLevelOk === null ? "" : waterLevelOk ? styles.reserveGood : styles.reserveLow
                }`}
              >
                <span className="statusDot" />
                <strong>{waterLevelOk === null ? "No reading" : waterLevelOk ? "Enough water" : "Refill soon"}</strong>
              </div>
            </div>
            <div className={styles.waterSystemGrid}>
              <div className={styles.reservoirBlock}>
                <span className={styles.visualLabel}>Main reservoir</span>
                <div className={styles.reservoirTank}>
                  <div className={styles.reservoirColumn}>
                    <div className={styles.reservoirThreshold}>
                      <span className={styles.reservoirThresholdLine} />
                      <span className={styles.reservoirThresholdLabel}>Level sensor</span>
                    </div>
                    <div className={styles.reservoirFill}>
                      <span className={styles.chamberWave} />
                      <span className={styles.chamberWaveAlt} />
                    </div>
                  </div>
                  <div className={styles.reservoirScale}>
                    <span>100</span>
                    <span>50</span>
                    <span>0</span>
                  </div>
                </div>
              </div>
            </div>
            <div className={styles.chamberStats}>
              <span>{waterLevelText}</span>
            </div>
          </div>
        ),
        metrics: [
          {
            label: "pH",
            value: formatOptionalMetric(waterPh, "", 2),
            tone: "stable" as const,
          },
          {
            label: "EC",
            value: formatOptionalMetric(waterEc, "mS/cm", 2),
            tone: "focus" as const,
          },
          {
            label: "Water Level",
            value: waterLevelOk === null ? "No reading" : waterLevelOk ? "OK" : "LOW",
            tone: "watch" as const,
          },
        ],
      },
      {
        title: "Light",
        icon: "/images/light-icon.svg",
        fallback: LIGHT_FALLBACK,
        accent: "lime" as const,
        heroLabel: "Canopy PPFD",
        heroValue: formatOptionalMetric(lightPpfd, "PPFD", 1),
        metrics: [],
      },
    ],
    [
      airTemperature,
      fmt,
      humidity,
      lightPpfd,
      pressure,
      reservoirLevel,
      waterEc,
      waterLevelOk,
      waterLevelText,
      waterPh,
      waterTemperature,
    ],
  );

  if (!farm) return <NoFarmNotice title="Farm" />;

  return (
    <section className="pageSection">
      <header className={styles.statusRow}>
        <div className={styles.identity}>
          <span className="eyebrow">Farm</span>
          <h1 className={styles.identityTitle}>{farm.name}</h1>
        </div>

        <div className={styles.chips}>
          <span
            className={`${styles.chip} ${mounted ? styles[liveStatus] ?? "" : ""}`}
            title={reading ? `Reading the latest sensor event for ${farm.name}` : `No sensor readings from ${farm.name} yet`}
          >
            <span className="statusDot" />
            {!mounted ? "Connecting" : STATUS_LABEL[liveStatus]}
          </span>
          <span className={styles.chip}>
            <span className={styles.chipLabel}>Updated</span>
            <time suppressHydrationWarning>{lastUpdate ? fmt.time(lastUpdate) : "Never"}</time>
          </span>
        </div>
      </header>

      <div className={styles.sensorGrid}>
        {mounted
          ? sensorCards.map((card) => <SensorCard key={card.title} {...card} />)
          : sensorCards.map((card) => <div key={card.title} className="loadingCard" aria-hidden />)}
        <RobotsCard />
      </div>
    </section>
  );
}
