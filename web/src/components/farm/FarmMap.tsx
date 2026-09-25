"use client";

import { useEffect, useMemo, useRef } from "react";
import { FarmRenderer, type RouteDraw, type RouteStyle } from "@/lib/farm/map/renderer";
import type { Scene } from "@/lib/farm/map/layout";
import { resolveNode, type NavGraph } from "@/lib/farm/navigation";
import { toRobotDraw, type RobotView } from "@/lib/farm/robots";
import styles from "@/components/farm/FarmMap.module.css";

const ACCENT = "#D9722E";

export interface FarmMapProps {
  scene: Scene;
  graph: NavGraph;
  robots: RobotView[];
  now: number;
  selectedRobotId: string | null;
  aisleY: number;
  onAisleChange: (aisleY: number) => void;
  targetNodeId?: string | null;
  /** Node ids the operator can pick as a target */
  targetable?: Set<string>;
  onNodeClick?: (nodeId: string) => void;
  onRobotClick?: (robotId: string) => void;
  route?: RouteDraw | null;
  routeStyle?: RouteStyle;
  onRouteStyleChange?: (style: RouteStyle) => void;
  /** Shown over the map when there is nothing live to draw */
  emptyMessage?: string | null;
}

const EMPTY = new Set<string>();

export function FarmMap({
  scene,
  graph,
  robots,
  now,
  selectedRobotId,
  aisleY,
  onAisleChange,
  targetNodeId = null,
  targetable = EMPTY,
  onNodeClick,
  onRobotClick,
  route = null,
  routeStyle = "trail",
  onRouteStyleChange,
  emptyMessage,
}: FarmMapProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const rendererRef = useRef<FarmRenderer | null>(null);
  const handlers = useRef({ onNodeClick, onRobotClick });
  handlers.current = { onNodeClick, onRobotClick };

  useEffect(() => {
    if (!svgRef.current) return undefined;
    const renderer = new FarmRenderer(svgRef.current, {
      accent: ACCENT,
      onNodeClick: (id) => handlers.current.onNodeClick?.(id),
      onRobotClick: (id) => handlers.current.onRobotClick?.(id),
    });
    rendererRef.current = renderer;
    return () => {
      renderer.destroy();
      rendererRef.current = null;
    };
  }, []);

  const draws = useMemo(() => robots.map((robot) => toRobotDraw(robot, graph, now)), [graph, now, robots]);

  useEffect(() => {
    rendererRef.current?.render({
      scene,
      graph,
      aisleY,
      robots: draws,
      selectedId: selectedRobotId,
      targetNodeId,
      targetable,
      route,
      routeStyle,
    });
  }, [aisleY, draws, graph, route, routeStyle, scene, selectedRobotId, targetNodeId, targetable]);

  // which aisles currently hold a robot (dot on the tab)
  const occupiedAisles = useMemo(() => {
    const set = new Set<number>();
    for (const robot of draws) {
      if (robot.nodeId) {
        const y = scene.nodeAisle.get(robot.nodeId);
        if (y !== undefined) set.add(y);
      }
    }
    return set;
  }, [draws, scene]);

  const selected = robots.find((robot) => robot.id === selectedRobotId);
  const selectedDraw = draws.find((robot) => robot.id === selectedRobotId);
  const selectedNode = selected ? resolveNode(graph, selected.currentNode) : undefined;
  const selectedLevel = selectedNode ? scene.levels.findIndex((lv) => lv.z === selectedNode.z) + 1 : 0;
  const selectedAisle = selectedNode ? scene.aisles.find((a) => a.y === selectedNode.y)?.name : undefined;

  return (
    <div className={styles.map}>
      <div className={styles.toolbar}>
        <span className={styles.toolLabel}>Aisle</span>
        <div className={styles.segmented} role="tablist" aria-label="Aisle">
          {scene.aisles.map((aisle) => (
            <button
              key={aisle.y}
              type="button"
              role="tab"
              aria-selected={aisle.y === aisleY}
              className={`${styles.segment} ${aisle.y === aisleY ? styles.segmentOn : ""}`}
              onClick={() => onAisleChange(aisle.y)}
            >
              {aisle.name}
              {occupiedAisles.has(aisle.y) ? <span className={styles.tabDot} aria-label="robot in this aisle" /> : null}
            </button>
          ))}
        </div>

        {onRouteStyleChange ? (
          <div className={styles.routeStyle}>
            <span className={styles.toolLabel}>Route</span>
            <div className={styles.segmented} role="radiogroup" aria-label="Route display">
              {(["trail", "checkpoint"] as RouteStyle[]).map((style) => (
                <button
                  key={style}
                  type="button"
                  role="radio"
                  aria-checked={routeStyle === style}
                  className={`${styles.segment} ${routeStyle === style ? styles.segmentOn : ""}`}
                  onClick={() => onRouteStyleChange(style)}
                >
                  {style === "trail" ? "Trail" : "Checkpoint"}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <span className={styles.caption}>Side-view cross-section</span>
      </div>

      <div className={styles.canvas}>
        <svg
          ref={svgRef}
          viewBox={`0 0 660 ${scene.viewH}`}
          width="100%"
          role="img"
          aria-label="Side-view cross-section of the farm showing robots on each shelf level, the charging dock and the elevator"
        />
        {emptyMessage ? <div className={styles.overlay}>{emptyMessage}</div> : null}
      </div>

      <div className={styles.legend}>
        <span><i style={{ background: "#8B7FD4" }} /> Grow lights</span>
        <span><i style={{ background: "#5A93B5" }} /> Water basin</span>
        <span><i style={{ background: ACCENT }} /> Selected rover</span>
        <span><i style={{ background: "#9A938C" }} /> Other rovers</span>
        <span><i style={{ background: "#C9A227" }} /> Charging dock</span>
        <span><i className={styles.dashed} /> Empty slot</span>
        {routeStyle === "checkpoint" ? (
          <>
            <span><i style={{ background: "#7D8791" }} /> Planned route</span>
            <span><i style={{ background: "#7FC8B8" }} /> Current leg</span>
          </>
        ) : null}
      </div>

      <div className={styles.status}>
        {selected ? (
          <>
            <strong>{selected.id}</strong>
            <span>
              {selectedNode
                ? `${selectedNode.id} (${selectedAisle ? `Aisle ${selectedAisle}, ` : ""}L${selectedLevel})`
                : "Position unknown"}
            </span>
            <span>Canopy {selectedDraw?.health ?? "good"}</span>
            <span>{selectedDraw?.action}</span>
            <span>Battery {Math.round(selected.batteryPct)}%</span>
          </>
        ) : (
          <span>No robot selected</span>
        )}
      </div>
    </div>
  );
}
