"use client";

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
  const waterTemperature = reading?.waterTemperature ?? null;
  const waterPh = reading?.ph ?? null;
  const lightLux = reading?.lightLux ?? null;
  const waterLevelOk = reading?.waterLevelOk ?? null;

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
        ],
      },
      {
        title: "Water",
        icon: "/images/water-icon.svg",
        fallback: WATER_FALLBACK,
        accent: "teal" as const,
        heroLabel: "Water Temperature",
        heroValue: fmt.temp(waterTemperature, 1),
        metrics: [
          {
            label: "pH",
            value: formatOptionalMetric(waterPh, "", 2),
            tone: "stable" as const,
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
        heroLabel: "Light",
        heroValue: formatOptionalMetric(lightLux, "lux", 0),
        metrics: [],
      },
    ],
    [
      airTemperature,
      fmt,
      humidity,
      lightLux,
      waterLevelOk,
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
