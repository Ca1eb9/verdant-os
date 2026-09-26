"use client";

import { useCallback, useMemo, useState } from "react";
import { ControlPanel } from "@/components/farm/ControlPanel";
import { FarmMap } from "@/components/farm/FarmMap";
import { useFarmLive } from "@/hooks/useFarmLive";
import { useRobotRoutes } from "@/hooks/useRobotRoutes";
import type { RouteDraw } from "@/lib/farm/map/renderer";
import { dijkstra, resolveNode } from "@/lib/farm/navigation";
import styles from "@/components/farm/FarmView.module.css";

export function FarmView() {
  const { source, topology, usingDefaultTopology, graph, scene, robots, now } = useFarmLive();
  const routes = useRobotRoutes(graph, robots);

  const [pickedRobotId, setPickedRobotId] = useState<string | null>(null);
  const [manualAisle, setManualAisle] = useState<number | null>(null);
  const [targetNodeId, setTargetNodeId] = useState<string | null>(null);

  // never null while any robot exists: fall back to the first one
  const selectedRobotId = robots.some((r) => r.id === pickedRobotId) ? pickedRobotId : robots[0]?.id ?? null;
  const selected = robots.find((r) => r.id === selectedRobotId);
  const selectedNode = selected ? resolveNode(graph, selected.currentNode) : undefined;

  // the aisle follows the selected robot until the operator picks a tab
  const aisleIds = scene.aisles.map((a) => a.y);
  const followAisle = selectedNode && aisleIds.includes(selectedNode.y) ? selectedNode.y : aisleIds[0] ?? 0;
  const aisleY = manualAisle !== null && aisleIds.includes(manualAisle) ? manualAisle : followAisle;

  const selectRobot = useCallback((id: string) => {
    setPickedRobotId(id);
    setManualAisle(null);
  }, []);

  const targetable = useMemo(
    () => new Set(topology.nodes.filter((n) => n.type !== "elevator").map((n) => n.id)),
    [topology],
  );

  const route: RouteDraw | null = useMemo(() => {
    const from = selectedNode?.id;
    if (targetNodeId && from && targetNodeId !== from) {
      const nodes = dijkstra(graph, from, targetNodeId);
      if (nodes && nodes.length > 1) return { nodes, progress: 0, mode: "preview" };
    }
    return routes.routeFor(selected);
  }, [graph, routes, selected, selectedNode, targetNodeId]);

  const emptyMessage = robots.length
    ? null
    : usingDefaultTopology
      ? "Waiting for robot telemetry · showing the default farm layout"
      : "Waiting for robot telemetry";

  return (
    <section className="pageSection">
      <header className={styles.header}>
        <div>
          <span className="eyebrow">Robots and layout</span>
          <h1 className="pageTitle">Farm</h1>
        </div>
        <p className={styles.lead}>
          {topology.name}
          {usingDefaultTopology ? " (default until the farm sends its topology)" : ""}. Click a rover to select it, or a
          slot to pick a target.
        </p>
      </header>

      <div className={styles.grid}>
        <div className={`glassPanel ${styles.mapCard}`}>
          <FarmMap
            scene={scene}
            graph={graph}
            robots={robots}
            now={now}
            selectedRobotId={selectedRobotId}
            aisleY={aisleY}
            onAisleChange={setManualAisle}
            targetNodeId={targetNodeId}
            targetable={targetable}
            onNodeClick={(id) => setTargetNodeId((current) => (current === id ? null : id))}
            onRobotClick={selectRobot}
            route={route}
            emptyMessage={emptyMessage}
          />
        </div>

        <ControlPanel
          source={source}
          topology={topology}
          graph={graph}
          scene={scene}
          robots={robots}
          now={now}
          selectedRobotId={selectedRobotId}
          onSelectRobot={selectRobot}
          targetNodeId={targetNodeId}
          onTargetChange={(id) => {
            setTargetNodeId(id);
            const node = id ? graph.nodes.get(id) : undefined;
            if (node) setManualAisle(node.y);
          }}
          onRouteStart={routes.startRoute}
          onRouteClear={routes.clearRoute}
        />
      </div>
    </section>
  );
}
