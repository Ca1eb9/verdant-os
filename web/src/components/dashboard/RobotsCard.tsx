"use client";

import Link from "next/link";
import { useFarmLive } from "@/hooks/useFarmLive";
import { resolveNode } from "@/lib/farm/navigation";
import { isStale, statusLabel } from "@/lib/farm/robots";
import styles from "@/components/dashboard/DashboardView.module.css";

export function RobotsCard() {
  const { robots, graph, now } = useFarmLive();

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
