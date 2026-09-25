"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { RouteDraw } from "@/lib/farm/map/renderer";
import { dijkstra, resolveNode, type NavGraph } from "@/lib/farm/navigation";
import { isMoving, type RobotView } from "@/lib/farm/robots";

interface PlannedRoute {
  key: string;
  target: string;
  nodes: string[];
  /** Target reached; kept briefly so the last leg can fade out */
  done?: boolean;
}

const DONE_LINGER_MS = 3_500;

const ENDED = new Set(["error", "lost", "manual"]);

/**
 * Tracks the route a robot was sent on, so the map can show how far along it
 * is. Progress only advances when telemetry reports the robot at a node.
 */
export function useRobotRoutes(graph: NavGraph, robots: RobotView[]) {
  const [routes, setRoutes] = useState<Record<string, PlannedRoute>>({});

  const startRoute = useCallback(
    (robot: RobotView, target: string) => {
      const from = resolveNode(graph, robot.currentNode)?.id;
      const planned = robot.expectedPath
        ?.map((ref) => resolveNode(graph, ref)?.id)
        .filter((id): id is string => Boolean(id));
      const nodes = planned && planned.length > 1 && planned[planned.length - 1] === target
        ? planned
        : from ? dijkstra(graph, from, target) : null;
      if (!nodes || nodes.length < 2) return;
      setRoutes((prev) => ({ ...prev, [robot.id]: { key: `${robot.id}:${Date.now()}`, target, nodes } }));
    },
    [graph],
  );

  const clearRoute = useCallback((robotId: string) => {
    setRoutes((prev) => {
      if (!prev[robotId]) return prev;
      const next = { ...prev };
      delete next[robotId];
      return next;
    });
  }, []);

  // keep routes in step with telemetry: re-plan on detours, drop finished ones
  useEffect(() => {
    setRoutes((prev) => {
      let changed = false;
      const next: Record<string, PlannedRoute> = {};
      for (const [id, route] of Object.entries(prev)) {
        const robot = robots.find((r) => r.id === id);
        const at = robot ? resolveNode(graph, robot.currentNode)?.id : undefined;
        if (!robot || !at || ENDED.has(robot.status)) {
          changed = true;
          continue;
        }
        if (route.done) {
          next[id] = route;
          continue;
        }
        if (at === route.target && !isMoving(robot.status)) {
          changed = true;
          next[id] = { ...route, done: true };
          continue;
        }
        if (!route.nodes.includes(at)) {
          const replanned = dijkstra(graph, at, route.target);
          changed = true;
          if (replanned && replanned.length > 1) next[id] = { key: `${id}:${Date.now()}`, target: route.target, nodes: replanned };
          continue;
        }
        next[id] = route;
      }
      return changed ? next : prev;
    });
  }, [graph, robots]);

  // drop finished routes once their last leg has faded
  useEffect(() => {
    const finished = Object.entries(routes).filter(([, route]) => route.done);
    if (!finished.length) return undefined;
    const timer = window.setTimeout(() => {
      setRoutes((prev) => {
        const next = { ...prev };
        for (const [id, route] of finished) if (next[id] === route) delete next[id];
        return next;
      });
    }, DONE_LINGER_MS);
    return () => window.clearTimeout(timer);
  }, [routes]);

  const routeFor = useCallback(
    (robot: RobotView | undefined): RouteDraw | null => {
      if (!robot) return null;
      const route = routes[robot.id];
      if (!route) return null;
      const at = resolveNode(graph, robot.currentNode)?.id;
      return {
        key: route.key,
        nodes: route.nodes,
        progress: route.done ? route.nodes.length - 1 : at ? Math.max(0, route.nodes.indexOf(at)) : 0,
        mode: "active",
        moving: isMoving(robot.status),
      };
    },
    [graph, routes],
  );

  return useMemo(() => ({ startRoute, clearRoute, routeFor }), [clearRoute, routeFor, startRoute]);
}
