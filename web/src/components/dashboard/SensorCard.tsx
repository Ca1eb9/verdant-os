import type { CSSProperties, ReactNode } from "react";
import { AssetImage } from "@/components/ui/AssetImage";
import styles from "@/components/dashboard/DashboardView.module.css";

type CardAccent = "cyan" | "teal" | "lime";
type MetricTone = "stable" | "watch" | "focus";

interface SensorCardMetric {
  label: string;
  value: string;
  hint: string;
  tone: MetricTone;
}

interface SensorCardProps {
  title: string;
  subtitle: string;
  icon: string;
  fallback: string;
  accent: CardAccent;
  heroLabel: string;
  heroValue: string;
  trend: string;
  metrics: SensorCardMetric[];
  visual?: ReactNode;
}

const accentMap: Record<CardAccent, string> = {
  cyan: "103, 223, 255",
  teal: "111, 247, 195",
  lime: "216, 255, 114",
};

export function SensorCard({
  accent,
  fallback,
  heroLabel,
  heroValue,
  icon,
  metrics,
  subtitle,
  title,
  trend,
  visual,
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
        <div className={styles.sensorHead}>
          <span className="eyebrow">{title}</span>
          <h2 className={styles.sensorTitle}>{title}</h2>
          <p className={styles.sensorSubtitle}>{subtitle}</p>
        </div>
      </div>

      <div className={styles.heroValueBlock}>
        <span className={styles.heroValueLabel}>{heroLabel}</span>
        <strong className={styles.heroValue}>{heroValue}</strong>
        <span className={styles.heroTrend}>{trend}</span>
      </div>

      {visual ? <div className={styles.sensorVisual}>{visual}</div> : null}

      <div className={styles.metricGrid}>
        {metrics.map((metric) => (
          <div key={metric.label} className={styles.metricTile}>
            <div className={styles.metricLabelRow}>
              <span className={styles.metricLabel}>{metric.label}</span>
              <span className={`${styles.metricTone} ${styles[`tone${metric.tone}`]}`} />
            </div>
            <strong className={styles.metricValue}>{metric.value}</strong>
            <span className={styles.metricHint}>{metric.hint}</span>
          </div>
        ))}
      </div>
    </article>
  );
}
