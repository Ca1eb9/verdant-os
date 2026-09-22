// ============================================================
// Navigation utilities — used by orchestrator for pathfinding
// and should be similar to ESP32 firmware logic
// ============================================================

import { GraphNode, GraphEdge, FarmTopology, Heading, Turn } from "./types.js";

// --- Heading & turn math -------------------------------------

export function computeHeading(from: GraphNode, to: GraphNode): Heading | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;

  // Vertical-only move (elevator) — heading unchanged
  if (dx === 0 && dy === 0) return null;

  if (dy > 0) return Heading.NORTH;
  if (dy < 0) return Heading.SOUTH;
  if (dx > 0) return Heading.EAST;
  return Heading.WEST;
}

export function computeTurn(current: Heading, desired: Heading): Turn {
  return ((desired - current + 4) % 4) as Turn;
}

/**
 * Convert a path of node IDs into a sequence of turns.
 * Requires the robot's current heading to compute the first turn.
 */
export function pathToTurns(
  path: GraphNode[],
  initialHeading: Heading
): { node: GraphNode; turn: Turn; newHeading: Heading }[] {
  const result: { node: GraphNode; turn: Turn; newHeading: Heading }[] = [];
  let heading = initialHeading;

  for (let i = 0; i < path.length - 1; i++) {
    const desired = computeHeading(path[i], path[i + 1]);
    if (desired !== null) {
      const turn = computeTurn(heading, desired);
      result.push({ node: path[i], turn, newHeading: desired });
      heading = desired;
    } else {
      // Elevator move — no turn, heading stays the same
      result.push({ node: path[i], turn: Turn.STRAIGHT, newHeading: heading });
    }
  }

  return result;
}

// --- Graph & Dijkstra ----------------------------------------

export interface NavGraph {
  nodes: Map<string, GraphNode>;
  adjacency: Map<string, { neighborId: string; cost: number }[]>;
}

/** Build an in-memory navigation graph from topology JSON */
export function buildGraph(topology: FarmTopology): NavGraph {
  const nodes = new Map<string, GraphNode>();
  const adjacency = new Map<string, { neighborId: string; cost: number }[]>();

  for (const node of topology.nodes) {
    nodes.set(node.id, node);
    adjacency.set(node.id, []);
  }

  for (const edge of topology.edges) {
    const bidirectional = edge.bidirectional !== false; // default true

    adjacency.get(edge.from)?.push({ neighborId: edge.to, cost: edge.cost });
    if (bidirectional) {
      adjacency.get(edge.to)?.push({ neighborId: edge.from, cost: edge.cost });
    }
  }

  return { nodes, adjacency };
}

/** Find the node that corresponds to a given RFID tag */
export function nodeByTag(graph: NavGraph, tagId: string): GraphNode | undefined {
  for (const node of graph.nodes.values()) {
    if (node.tag_id === tagId) return node;
  }
  return undefined;
}

/**
 * Dijkstra's shortest path.
 * Returns the ordered list of node IDs from start to end (inclusive),
 * or null if no path exists.
 */
export function dijkstra(
  graph: NavGraph,
  startId: string,
  endId: string
): string[] | null {
  const dist = new Map<string, number>();
  const prev = new Map<string, string | null>();
  const visited = new Set<string>();

  for (const id of graph.nodes.keys()) {
    dist.set(id, Infinity);
    prev.set(id, null);
  }
  dist.set(startId, 0);

  while (true) {
    // Find unvisited node with smallest distance
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

    const neighbors = graph.adjacency.get(current) ?? [];
    for (const { neighborId, cost } of neighbors) {
      if (visited.has(neighborId)) continue;
      const newDist = currentDist + cost;
      if (newDist < (dist.get(neighborId) ?? Infinity)) {
        dist.set(neighborId, newDist);
        prev.set(neighborId, current);
      }
    }
  }

  // Reconstruct path
  if (dist.get(endId) === Infinity) return null;

  const path: string[] = [];
  let node: string | null = endId;
  while (node !== null) {
    path.unshift(node);
    node = prev.get(node) ?? null;
  }

  return path;
}

/**
 * Compute the full path with RFID tags for sending to the robot.
 * Returns tag IDs instead of node IDs.
 */
export function computePathTags(
  graph: NavGraph,
  startId: string,
  endId: string
): string[] | null {
  const nodeIds = dijkstra(graph, startId, endId);
  if (!nodeIds) return null;

  return nodeIds.map((id) => {
    const node = graph.nodes.get(id);
    if (!node) throw new Error(`Node ${id} not found in graph`);
    return node.tag_id;
  });
}
