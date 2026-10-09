"use client";

import Link from "next/link";
import { useState } from "react";
import { FarmMap } from "@/components/farm/FarmMap";
import { useFarmLive } from "@/hooks/useFarmLive";
import { resolveNode } from "@/lib/farm/navigation";
import styles from "@/components/dashboard/DashboardView.module.css";

/** The live farm map, watch-only: commands and robot details live on the Farm page */
export function FarmMapCard() {
  const { graph, scene, robots, now, usingDefaultTopology } = useFarmLive();
  const [manualAisle, setManualAisle] = useState<number | null>(null);

  // the aisle follows the first robot until the operator picks a tab
  const aisleIds = scene.aisles.map((a) => a.y);
  const firstNode = robots[0] ? resolveNode(graph, robots[0].currentNode) : undefined;
  const followAisle = firstNode && aisleIds.includes(firstNode.y) ? firstNode.y : aisleIds[0] ?? 0;
  const aisleY = manualAisle !== null && aisleIds.includes(manualAisle) ? manualAisle : followAisle;

  const emptyMessage = robots.length
    ? null
    : usingDefaultTopology
      ? "Waiting for robot telemetry · showing the default farm layout"
      : "Waiting for robot telemetry";

  return (
    <article className={`glassPanel ${styles.sensorCard} ${styles.mapCard}`}>
      <div className={styles.sensorTop}>
        <h2 className={styles.sensorTitle}>Farm map</h2>
        <Link href="/farm" className={styles.cardLink}>
          Open farm map →
        </Link>
      </div>
      <FarmMap
        scene={scene}
        graph={graph}
        robots={robots}
        now={now}
        selectedRobotId={null}
        aisleY={aisleY}
        onAisleChange={setManualAisle}
        emptyMessage={emptyMessage}
        overview
      />
    </article>
  );
}
