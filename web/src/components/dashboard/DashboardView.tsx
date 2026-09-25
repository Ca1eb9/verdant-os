"use client";

import type { CSSProperties } from "react";
import { useEffect, useMemo, useState } from "react";
import { RobotsCard } from "@/components/dashboard/RobotsCard";
import { SensorCard } from "@/components/dashboard/SensorCard";
import { useSelectedFarm } from "@/components/farms/FarmContext";
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

export function DashboardView() {
  const { activeFarmId, farm } = useSelectedFarm();
  const { fmt } = usePreferences();
  // readings are generated in the browser; the prerendered page shows placeholders instead
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const { snapshot, lastUpdate, liveStatus, latestEvent } = useFarmTelemetry(
    activeFarmId,
  );

  const airTemperature = latestEvent ? latestEvent.air_temp_c : snapshot.air.temperature;
  const humidity = latestEvent ? latestEvent.humidity_pct : snapshot.air.humidity;
  const waterTemperature = latestEvent ? latestEvent.water_temp_c : snapshot.water.temperature;
  const waterPh = latestEvent ? latestEvent.ph : snapshot.water.ph;
  const lightPpfd = latestEvent ? latestEvent.light_ppfd : snapshot.light.ppfd;
  const reservoirLevel = Math.min(92, Math.max(12, snapshot.water.level));
  const reservoirHealthy = snapshot.water.level >= 50;
  const waterLevelText =
    latestEvent?.water_level_text ??
    snapshot.water.levelText ??
    (snapshot.water.levelFloat === 1 ? "Liquid detected" : "No liquid detected");

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
            value: formatMetric(snapshot.air.pressure, "hPa", 1),
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
                  reservoirHealthy ? styles.reserveGood : styles.reserveLow
                }`}
              >
                <span className="statusDot" />
                <strong>{reservoirHealthy ? "Enough water" : "Refill soon"}</strong>
              </div>
            </div>
            <div className={styles.waterSystemGrid}>
              <div className={styles.reservoirBlock}>
                <span className={styles.visualLabel}>Main reservoir</span>
                <div className={styles.reservoirTank}>
                  <div className={styles.reservoirColumn}>
                    <div className={styles.reservoirThreshold}>
                      <span className={styles.reservoirThresholdLine} />
                      <span className={styles.reservoirThresholdLabel}>50% minimum</span>
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
              <span suppressHydrationWarning>{formatMetric(snapshot.water.level, "%", 0)} volume</span>
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
            value: formatMetric(snapshot.water.ec, "mS/cm", 2),
            tone: "focus" as const,
          },
          {
            label: "Water Level",
            value: formatMetric(snapshot.water.level, "%", 0),
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
      reservoirHealthy,
      reservoirLevel,
      snapshot,
      waterLevelText,
      waterPh,
      waterTemperature,
    ],
  );

  return (
    <section className="pageSection">
      <header className={styles.statusRow}>
        <div className={styles.identity}>
          <span className="eyebrow">Farm</span>
          <h1 className={styles.identityTitle}>{farm.name}</h1>
        </div>

        <div className={styles.chips}>
          <span
            className={`${styles.chip} ${mounted ? styles[liveStatus] : ""}`}
            title={latestEvent ? `Reading the latest sensor event for ${farm.name}` : "Waiting for the first sensor event"}
          >
            <span className="statusDot" />
            {!mounted ? "Connecting" : liveStatus === "live" ? "Live feed" : "Stale snapshot"}
          </span>
          <span className={styles.chip}>
            <span className={styles.chipLabel}>Updated</span>
            <time suppressHydrationWarning>{fmt.time(lastUpdate)}</time>
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
