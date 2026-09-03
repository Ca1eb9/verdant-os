"use client";

import type { CSSProperties } from "react";
import { useMemo } from "react";
import { SensorCard } from "@/components/dashboard/SensorCard";
import { useSelectedFarm } from "@/components/farms/FarmContext";
import { AssetImage } from "@/components/ui/AssetImage";
import { useFarmTelemetry } from "@/hooks/useFarmTelemetry";
import { formatMetric, formatTimestamp } from "@/lib/format";
import { FARMS } from "@/lib/mock-data";
import styles from "@/components/dashboard/DashboardView.module.css";

const AIR_FALLBACK = "\uD83C\uDF2C\uFE0F";
const WATER_FALLBACK = "\uD83D\uDCA7";
const LIGHT_FALLBACK = "\uD83D\uDCA1";
const LOGO_FALLBACK = "\uD83C\uDF3F";
const DEGREE_C = "\u00B0C";

function formatOptionalMetric(value: number | null, unit: string, precision = 1) {
  return value === null ? "No reading" : formatMetric(value, unit, precision);
}

export function DashboardView() {
  const { activeFarmId, farm, setActiveFarmId } = useSelectedFarm();
  const { snapshot, lastUpdate, isOnline, liveStatus, latestEvent } = useFarmTelemetry(
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
        subtitle: "Canopy climate and atmospheric stability.",
        icon: "/images/air-icon.svg",
        fallback: AIR_FALLBACK,
        accent: "cyan" as const,
        heroLabel: "Air Temperature",
        heroValue: formatOptionalMetric(airTemperature, DEGREE_C, 1),
        trend: "Humidity and pressure remain inside cultivation band.",
        metrics: [
          {
            label: "Humidity",
            value: formatOptionalMetric(humidity, "%", 0),
            hint: "Balanced vapor pressure deficit window",
            tone: "stable" as const,
          },
          {
            label: "Pressure",
            value: formatMetric(snapshot.air.pressure, "hPa", 1),
            hint: "Clean airflow profile across the stack",
            tone: "focus" as const,
          },
        ],
      },
      {
        title: "Water",
        subtitle: "Nutrient loop chemistry and reservoir condition.",
        icon: "/images/water-icon.svg",
        fallback: WATER_FALLBACK,
        accent: "teal" as const,
        heroLabel: "Water Temperature",
        heroValue: formatOptionalMetric(waterTemperature, DEGREE_C, 1),
        trend: "Reservoir volume and nutrient chemistry are tracking feed targets.",
        visual: (
          <div
            className={styles.waterChamber}
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
              <span>{formatMetric(snapshot.water.level, "%", 0)} volume</span>
              <span>{waterLevelText}</span>
            </div>
          </div>
        ),
        metrics: [
          {
            label: "pH",
            value: formatOptionalMetric(waterPh, "", 2),
            hint: "Nutrient uptake is aligned with recipe band",
            tone: "stable" as const,
          },
          {
            label: "EC",
            value: formatMetric(snapshot.water.ec, "mS/cm", 2),
            hint: "Conductivity is steady through recirculation",
            tone: "focus" as const,
          },
          {
            label: "Water Level",
            value: formatMetric(snapshot.water.level, "%", 0),
            hint: "Main reservoir reserve for the recirculation loop",
            tone: "watch" as const,
          },
        ],
      },
      {
        title: "Light",
        subtitle: "Photonic output across the active grow canopy.",
        icon: "/images/light-icon.svg",
        fallback: LIGHT_FALLBACK,
        accent: "lime" as const,
        heroLabel: "Canopy PPFD",
        heroValue: formatOptionalMetric(lightPpfd, "PPFD", 1),
        trend: "Fixture banks are delivering calibrated photosynthetic light output.",
        metrics: [],
      },
    ],
    [
      airTemperature,
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
      <div className={`glassPanel ${styles.hero}`}>
        <div className={styles.identityPanel}>
          <div className={styles.logoCluster}>
            <AssetImage
              src="/images/sprout-logo.webp"
              alt="VerdantOS farm logo"
              fallback={LOGO_FALLBACK}
              className={styles.heroLogo}
              fallbackClassName={`${styles.heroLogo} assetFallback`}
            />
            <div className={styles.identityCopy}>
              <span className="eyebrow">Farm identity</span>
              <h1 className={styles.identityTitle}>{farm.name}</h1>
            </div>
          </div>
        </div>

        <div className={styles.metaGrid}>
          <div className={styles.metaCard}>
            <span className={styles.metaLabel}>Connection State</span>
            <div
              className={`${styles.statusValue} ${isOnline ? styles.online : styles.offline}`}
            >
              <span className="statusDot" />
              <strong>{isOnline ? "Online" : "Offline"}</strong>
            </div>
            <span className={styles.metaHint}>
              {isOnline
                ? "Gateway and telemetry bridge are reachable."
                : "PWA shell is active with the last known telemetry snapshot."}
            </span>
          </div>

          <div className={styles.metaCard}>
            <span className={styles.metaLabel}>Active Farm</span>
            <select
              className="controlSelect"
              value={activeFarmId}
              onChange={(event) => setActiveFarmId(event.target.value)}
              aria-label="Active farm selector"
            >
              {FARMS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </select>
            <span className={styles.metaHint}>
              Selected farm stays in sync across dashboard and history.
            </span>
          </div>

          <div className={styles.metaCard}>
            <span className={styles.metaLabel}>Last Update</span>
            <strong className={styles.metaValue}>{formatTimestamp(lastUpdate)}</strong>
            <span className={styles.metaHint}>Timestamp refreshes as new telemetry cycles in.</span>
          </div>

          <div className={styles.metaCard}>
            <span className={styles.metaLabel}>Live Status</span>
            <div className={`${styles.liveBadge} ${styles[liveStatus]}`}>
              <span className="statusDot" />
              <strong>{liveStatus === "live" ? "Live Feed" : "Stale Snapshot"}</strong>
            </div>
            <span className={styles.metaHint}>
              {latestEvent
                ? `Reading latest sensor event for ${farm.name}.`
                : `Waiting for the first sensor event for ${farm.name}.`}
            </span>
          </div>
        </div>
      </div>

      <div className={styles.sensorGrid}>
        {sensorCards.map((card) => (
          <SensorCard key={card.title} {...card} />
        ))}
      </div>
    </section>
  );
}
