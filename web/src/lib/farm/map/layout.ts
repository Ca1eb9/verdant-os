// Turns a FarmTopology into pixel positions for the side-view map.
// Geometry constants are the ones from the side-view design; only where
// nodes sit changes with the topology.

import type { FarmTopology, GraphNode, NodeType } from "@/lib/farm/types";

// ---- fixed geometry: dock bay | frame | aisle | elevator bay ----
export const W = 65; // rover / slot width, everything is sized off this
export const DOCK0 = 6;
export const DOCK1 = 92; // charging bay, off the left end of the lowest level
export const DOCKX = 26; // where a rover parks in the dock
export const FX = 96;
export const EX = 556; // structural frame
export const ELEV0 = 564;
export const ELEV1 = 564 + 81;
export const LANE_X = ELEV0 + 5; // rover x inside the elevator shaft
export const RH = 17; // rover height, chassis top to wheel bottom
export const DIPD = 10; // basin depth
export const TOP = 44; // top of the frame / elevator shaft
export const VIEW_W = 660;

const BASE_LEVELS = 3;
const LEVEL_PITCH = 100;
const BASE_GND = 362;
const BASE_VIEW_H = 395;
const BASE_SHELF_Y = 320;

export interface Level {
  /** Topology z value */
  z: number;
  /** Label shown on the shelf (L1, L2, ...) */
  id: number;
  shelfY: number;
  lightY: number;
}

export interface Dip {
  l: number;
  r: number;
  y: number;
  b: number;
  ramp: number;
}

export interface SlotPos {
  nodeId: string;
  type: NodeType;
  /** Rover left edge */
  x: number;
  /** Rover top (chassis) at rest on the flat rail */
  y: number;
  /** Level index into Scene.levels */
  lv: number;
  /** Width of the empty-slot outline (narrower only when a zone is crowded) */
  slotW: number;
}

export interface Aisle {
  /** Topology y value */
  y: number;
  name: string;
}

export interface Scene {
  levels: Level[];
  aisles: Aisle[];
  gnd: number;
  viewH: number;
  /** Node id -> aisle y (the dock belongs to the aisle it sits in) */
  nodeAisle: Map<string, number>;
  /** Node id -> pixel slot */
  slots: Map<string, SlotPos>;
}

export function dip(level: Level): Dip {
  const cx = (FX + EX) / 2;
  const half = (W / 2 + 4) * 3; // 3x the original basin
  return {
    l: Math.round(cx - half),
    r: Math.round(cx + half),
    y: level.shelfY,
    b: level.shelfY + DIPD,
    ramp: 16,
  };
}

/** How far a rover at x has dipped into this level's basin (0 on the flat rail) */
export function sinkAt(levels: Level[], x: number, li: number): number {
  const lv = levels[li];
  if (!lv) return 0;
  const dp = dip(lv);
  const R = dp.ramp;
  const S = DIPD - 2;
  const cx = x + W / 2;
  if (cx <= dp.l - R || cx >= dp.r + R) return 0;
  if (cx >= dp.l && cx <= dp.r) return S;
  return cx < dp.l ? (S * (cx - (dp.l - R))) / R : (S * (dp.r + R - cx)) / R;
}

export function levelOf(levels: Level[], y: number): number {
  for (let i = 0; i < levels.length; i++) {
    if (Math.abs(y - (levels[i].shelfY - RH)) < 0.8) return i;
  }
  return -1;
}

export function aisleName(index: number): string {
  let name = "";
  let n = index;
  do {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return name;
}

function buildLevels(zs: number[]): { levels: Level[]; gnd: number; viewH: number } {
  const count = Math.max(1, zs.length);
  const offset = (count - BASE_LEVELS) * LEVEL_PITCH;
  const levels = (zs.length ? zs : [0]).map((z, i) => {
    const shelfY = BASE_SHELF_Y + offset - LEVEL_PITCH * i;
    return { z, id: i + 1, shelfY, lightY: shelfY - 62 };
  });
  return { levels, gnd: BASE_GND + offset, viewH: BASE_VIEW_H + offset };
}

/** Spread n slots evenly between two rover x positions (the design's layout math) */
function spread(n: number, z0: number, z1: number, j: number) {
  return n <= 1 ? (z0 + z1) / 2 : z0 + (j * (z1 - z0)) / (n - 1);
}

/**
 * Place n slots across a stretch of flat rail. One slot keeps the design's
 * exact position; a crowded stretch splits into equal cells so the empty-slot
 * outlines sit side by side instead of on top of each other.
 */
function placeZone(
  ids: GraphNode[],
  zone: [number, number],
  rail: [number, number],
  out: (node: GraphNode, x: number, slotW: number) => void,
) {
  const n = ids.length;
  const fits = n * (W + 4) <= rail[1] - rail[0];
  if (n <= 1 || fits) {
    ids.forEach((node, j) => out(node, Math.round(spread(n, zone[0], zone[1], j)), W));
    return;
  }
  const cell = (rail[1] - rail[0]) / n;
  ids.forEach((node, j) => {
    const cx = rail[0] + cell * (j + 0.5);
    const x = Math.min(Math.max(cx - W / 2, FX + 2), EX - 2 - W); // keep the rover inside the frame
    out(node, Math.round(x), Math.max(18, Math.floor(cell - 4)));
  });
}

export function topologyToScene(topology: FarmTopology): Scene {
  const nodes = topology.nodes;
  const zs = Array.from(new Set(nodes.map((n) => n.z))).sort((a, b) => a - b);
  const ys = Array.from(new Set(nodes.map((n) => n.y))).sort((a, b) => a - b);
  const { levels, gnd, viewH } = buildLevels(zs);
  const lvIndex = new Map(levels.map((lv, i) => [lv.z, i]));
  const aisles = (ys.length ? ys : [0]).map((y, i) => ({ y, name: aisleName(i) }));
  const slots = new Map<string, SlotPos>();
  const nodeAisle = new Map<string, number>();

  const put = (node: GraphNode, x: number, lv: number, slotW = W) => {
    slots.set(node.id, { nodeId: node.id, type: node.type, x, y: levels[lv].shelfY - RH, lv, slotW });
  };

  for (const node of nodes) nodeAisle.set(node.id, node.y);

  for (const node of nodes) {
    const lv = lvIndex.get(node.z) ?? 0;
    // the charging bay sits off the left end of the lowest level
    if (node.type === "dock") put(node, DOCKX, 0);
    if (node.type === "elevator") put(node, LANE_X, lv);
  }

  for (const aisle of aisles) {
    levels.forEach((level, li) => {
      const onLevel = nodes
        .filter((n) => n.y === aisle.y && n.z === level.z)
        .filter((n) => n.type === "water" || n.type === "checkpoint")
        .sort((a, b) => a.x - b.x || a.id.localeCompare(b.id));
      const dp = dip(level);
      const water = onLevel.filter((n) => n.type === "water");
      const rest = onLevel.filter((n) => n.type !== "water");

      // water stations take the basin
      placeZone(
        water,
        [Math.round(dp.l + (dp.r - dp.l - W) / 2), Math.round(dp.l + (dp.r - dp.l - W) / 2)],
        [dp.l, dp.r],
        (node, x, slotW) => put(node, x, li, slotW),
      );

      // the rest spread either side of the basin, keeping their order along x
      let left: GraphNode[];
      let right: GraphNode[];
      if (water.length) {
        const wx = water[0].x;
        left = rest.filter((n) => n.x < wx);
        right = rest.filter((n) => n.x >= wx);
      } else {
        const nL = Math.ceil(rest.length / 2);
        left = rest.slice(0, nL);
        right = rest.slice(nL);
      }
      const lz: [number, number] = [FX + 24, dp.l - dp.ramp - 10 - W];
      const rz: [number, number] = [dp.r + dp.ramp + 10, EX - 10 - W];
      placeZone(left, lz, [FX + 6, dp.l - dp.ramp - 4], (node, x, slotW) => put(node, x, li, slotW));
      placeZone(right, rz, [dp.r + dp.ramp + 4, EX - 6], (node, x, slotW) => put(node, x, li, slotW));
    });
  }

  return { levels, aisles, gnd, viewH, nodeAisle, slots };
}
