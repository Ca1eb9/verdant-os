// Graph helpers mirrored from farm-controller/shared/src/navigation.ts.
// Keep in sync.

import type { FarmTopology, GraphNode } from "@/lib/farm/types";

export interface NavGraph {
  nodes: Map<string, GraphNode>;
  adjacency: Map<string, { neighborId: string; cost: number }[]>;
}

export function buildGraph(topology: FarmTopology): NavGraph {
  const nodes = new Map<string, GraphNode>();
  const adjacency = new Map<string, { neighborId: string; cost: number }[]>();

  for (const node of topology.nodes) {
    nodes.set(node.id, node);
    adjacency.set(node.id, []);
  }

  for (const edge of topology.edges) {
    const bidirectional = edge.bidirectional !== false;

    adjacency.get(edge.from)?.push({ neighborId: edge.to, cost: edge.cost });
    if (bidirectional) {
      adjacency.get(edge.to)?.push({ neighborId: edge.from, cost: edge.cost });
    }
  }

  return { nodes, adjacency };
}

export function nodeByTag(graph: NavGraph, tagId: string): GraphNode | undefined {
  for (const node of graph.nodes.values()) {
    if (node.tag_id === tagId) return node;
  }
  return undefined;
}

/** Resolve a telemetry current_node (a tag id, or a node id) to a node */
export function resolveNode(graph: NavGraph, ref: string | null | undefined): GraphNode | undefined {
  if (!ref) return undefined;
  return nodeByTag(graph, ref) ?? graph.nodes.get(ref);
}

/** Shortest path of node ids from start to end (inclusive), or null */
export function dijkstra(graph: NavGraph, startId: string, endId: string): string[] | null {
  if (!graph.nodes.has(startId) || !graph.nodes.has(endId)) return null;

  const dist = new Map<string, number>();
  const prev = new Map<string, string | null>();
  const visited = new Set<string>();

  for (const id of graph.nodes.keys()) {
    dist.set(id, Infinity);
    prev.set(id, null);
  }
  dist.set(startId, 0);

  while (true) {
    let current: string | null = null;
    let currentDist = Infinity;

    for (const [id, d] of dist) {
      if (!visited.has(id) && d < currentDist) {
        current = id;
        currentDist = d;
      }
    }

    if (current === null || current === endId) break;
    visited.add(current);

    for (const { neighborId, cost } of graph.adjacency.get(current) ?? []) {
      if (visited.has(neighborId)) continue;
      const newDist = currentDist + cost;
      if (newDist < (dist.get(neighborId) ?? Infinity)) {
        dist.set(neighborId, newDist);
        prev.set(neighborId, current);
      }
    }
  }

  if (dist.get(endId) === Infinity) return null;

  const path: string[] = [];
  let node: string | null = endId;
  while (node !== null) {
    path.unshift(node);
    node = prev.get(node) ?? null;
  }

  return path;
}
