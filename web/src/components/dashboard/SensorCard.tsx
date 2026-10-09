import type { CSSProperties } from "react";
import { AssetImage } from "@/components/ui/AssetImage";
import { MetricValue } from "@/components/ui/MetricValue";
import styles from "@/components/dashboard/DashboardView.module.css";

type CardAccent = "cyan" | "teal" | "lime";
/** A reading's alert state: in range, warning, critical, or no reading */
export type MetricTone = "ok" | "warning" | "critical" | "none";

const TONE_LABEL: Record<MetricTone, string> = {
  ok: "In range",
  warning: "Warning: outside the target range",
  critical: "Critical: outside the safe range",
  none: "No reading",
};

function ToneDot({ tone }: { tone: MetricTone }) {
  return (
    <span
      className={`${styles.metricTone} ${styles[`tone${tone}`]}`}
      role="img"
      aria-label={TONE_LABEL[tone]}
      title={TONE_LABEL[tone]}
    />
  );
}

interface SensorCardMetric {
  label: string;
  value: string;
  tone: MetricTone;
}

interface SensorCardProps {
  title: string;
  icon: string;
  fallback: string;
  accent: CardAccent;
  heroLabel: string;
  heroValue: string;
  /** Omitted for readings with no alert range (light) */
  heroTone?: MetricTone;
  metrics: SensorCardMetric[];
}

const accentMap: Record<CardAccent, string> = {
  cyan: "var(--cyan-rgb)",
  teal: "var(--teal-rgb)",
  lime: "var(--lime-rgb)",
};

export function SensorCard({
  accent,
  fallback,
  heroLabel,
  heroTone,
  heroValue,
  icon,
  metrics,
  title,
}: SensorCardProps) {
  return (
    <article
      className={`glassPanel ${styles.sensorCard}`}
      style={{ "--accent-rgb": accentMap[accent] } as CSSProperties}
    >
      <div className={styles.sensorTop}>
        <div className={styles.iconWrap}>
          <AssetImage
            src={icon}
            alt={`${title} icon`}
            fallback={fallback}
            className={styles.sensorIcon}
            fallbackClassName={`${styles.sensorIcon} assetFallback`}
          />
        </div>
        <h2 className={styles.sensorTitle}>{title}</h2>
      </div>

      <div className={styles.heroValueBlock}>
        <div className={styles.metricLabelRow}>
          <span className={styles.heroValueLabel}>{heroLabel}</span>
          {heroTone ? <ToneDot tone={heroTone} /> : null}
        </div>
        <strong className={styles.heroValue} suppressHydrationWarning>
          <MetricValue value={heroValue} />
        </strong>
      </div>


      <div className={styles.metricGrid}>
        {metrics.map((metric) => (
          <div key={metric.label} className={styles.metricTile}>
            <div className={styles.metricLabelRow}>
              <span className={styles.metricLabel}>{metric.label}</span>
              <ToneDot tone={metric.tone} />
            </div>
            <strong className={styles.metricValue} suppressHydrationWarning>
              <MetricValue value={metric.value} />
            </strong>
          </div>
        ))}
      </div>
    </article>
  );
}
