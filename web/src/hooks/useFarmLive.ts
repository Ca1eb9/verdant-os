"use client";

import { useEffect, useMemo, useState } from "react";
import { getFarmDataSource, onFarmDataSourceChange } from "@/lib/farm/data-source";
import { DEFAULT_TOPOLOGY } from "@/lib/farm/default-topology";
import { topologyToScene } from "@/lib/farm/map/layout";
import { buildGraph } from "@/lib/farm/navigation";
import type { RobotView } from "@/lib/farm/robots";
import type { FarmTopology } from "@/lib/farm/types";

const CLOCK_MS = 5_000;

/** Farm layout + live robot list from the active FarmDataSource */
export function useFarmLive() {
  const [source, setSource] = useState(getFarmDataSource);
  const [topology, setTopology] = useState<FarmTopology>(DEFAULT_TOPOLOGY);
  const [robots, setRobots] = useState<RobotView[]>([]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => onFarmDataSourceChange(() => setSource(getFarmDataSource())), []);

  useEffect(() => {
    let cancelled = false;
    source
      .getTopology()
      .then((next) => {
        if (!cancelled && next && next.nodes.length) setTopology(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [source]);

  useEffect(() => source.subscribeRobots((next) => setRobots([...next].sort((a, b) => a.id.localeCompare(b.id)))), [source]);

  // re-evaluate "stale" robots without waiting for a new message
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => window.clearInterval(id);
  }, []);

  const graph = useMemo(() => buildGraph(topology), [topology]);
  const scene = useMemo(() => topologyToScene(topology), [topology]);

  return {
    source,
    topology,
    usingDefaultTopology: topology === DEFAULT_TOPOLOGY,
    graph,
    scene,
    robots,
    now,
  };
}
