"use client";

import Link from "next/link";
import { usePreferences } from "@/components/preferences/PreferencesProvider";
import { useFarmLive } from "@/hooks/useFarmLive";
import { resolveNode } from "@/lib/farm/navigation";
import { isStale, statusLabel } from "@/lib/farm/robots";
import styles from "@/components/dashboard/DashboardView.module.css";

export function RobotsCard() {
  const { robots, graph, now } = useFarmLive();
  const { fmt } = usePreferences();

  return (
    <article className={`glassPanel ${styles.sensorCard} ${styles.robotsCard}`}>
      <div className={styles.sensorTop}>
        <h2 className={styles.sensorTitle}>Robots</h2>
        <Link href="/farm" className={styles.cardLink}>
          Open farm map →
        </Link>
      </div>

      {robots.length ? (
        <ul className={styles.robotList}>
          {robots.map((robot) => {
            const stale = isStale(robot, now);
            const node = resolveNode(graph, robot.currentNode);
            // The air around the robot, not the robot itself
            const air = [
              robot.temperatureC !== undefined && fmt.temp(robot.temperatureC),
              robot.humidityPct !== undefined && `${Math.round(robot.humidityPct)}% humidity`,
            ].filter(Boolean).join(" · ");
            return (
              <li key={robot.id} className={styles.metricTile}>
                <div className={styles.metricLabelRow}>
                  <strong>{robot.id}</strong>
                  <span className={`${styles.robotState} ${stale ? styles.stale : styles.live}`}>
                    {stale ? "Offline" : statusLabel(robot.status)}
                  </span>
                </div>
                <span className={styles.metricLabel}>
                  {node ? node.id : "Position unknown"} · Battery {Math.round(robot.batteryPct)}%
                </span>
                {air && <span className={styles.metricLabel}>Air {air}</span>}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className={styles.emptyNote}>No robots reporting yet. They appear here once the farm sends telemetry.</p>
      )}
    </article>
  );
}
