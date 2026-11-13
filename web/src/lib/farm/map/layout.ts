// Turns a FarmTopology into pixel positions for the side-view map.
// Geometry constants are the ones from the side-view design. Along a level,
// each topology x is a slot of equal width, in the same place on every level:
// the design's three (x 1 to 3) fill the frame. A level with a node further
// left grows its own shelf out to it, over the dock bay; one further right
// moves the elevator shaft, which every level meets, out to it. A water node
// sits in its slot like any other, dipped into a basin; water nodes in
// neighbouring slots share one basin.

import type { FarmTopology, GraphNode, NodeType } from "@/lib/farm/types";

// ---- fixed geometry: dock bay | frame | aisle | elevator bay ----
export const W = 65; // rover / slot width, everything is sized off this
export const DOCK0 = 6;
export const DOCK1 = 92; // charging bay, off the left end of the lowest level
export const DOCKX = 26; // where a rover parks in the dock
export const FX = 96; // the frame's left edge
const EX = 556; // its right edge with the design's three slots
const ELEV_GAP = 8; // frame to elevator shaft
const ELEV_W = 81;
const VIEW_PAD = 15; // right of the elevator shaft
export const RH = 17; // rover height, chassis top to wheel bottom
export const DIPD = 10; // basin depth
export const TOP = 44; // top of the frame / elevator shaft
const BASE_SLOTS = 3; // the design's level: topology x 1 to 3 between the frame's ends
/** One slot along a level, per topology x */
const SLOT = (EX - FX) / BASE_SLOTS;
const RAMP = 16; // a basin's sloped sides
/** Basin floor's edge from its slot's edge: room for the ramp and the frame's flange */
const BASIN_INSET = 25;

const BASE_LEVELS = 3;
const LEVEL_PITCH = 100;
const BASE_GND = 362;
const BASE_VIEW_H = 395;
const BASE_SHELF_Y = 320;

export interface Level {
  /** Topology z value */
  z: number;
  /** Label shown on the shelf (L1, L2, ...): the topology's z, counted from 1 for the operator */
  id: number;
  shelfY: number;
  lightY: number;
  /** Its water basins, left to right, by aisle y (none where it has no water) */
  basins: Map<number, Dip[]>;
  /** Its shelf's left end: the frame's, or further left for a node left of the design's three */
  left: number;
}

/** The map's horizontal geometry, wider than the design's for a level with more slots */
export interface Frame {
  /** The frame's right edge */
  EX: number;
  /** The elevator shaft */
  ELEV0: number;
  ELEV1: number;
  /** Rover x inside the elevator shaft */
  LANE_X: number;
  /** The view's left edge: below 0 when a level's shelf grows out past the dock bay */
  VIEW_X: number;
  VIEW_W: number;
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
  frame: Frame;
  aisles: Aisle[];
  gnd: number;
  viewH: number;
  /** Node id -> aisle y (the dock belongs to the aisle it sits in) */
  nodeAisle: Map<string, number>;
  /** Node id -> pixel slot */
  slots: Map<string, SlotPos>;
}

/** A level's basins in one aisle */
export function basinsOf(level: Level, aisleY: number): Dip[] {
  return level.basins.get(aisleY) ?? [];
}

/** How far a rover at x has dipped into its level's basins in this aisle (0 on the flat rail) */
export function sinkAt(levels: Level[], x: number, li: number, aisleY: number): number {
  const lv = levels[li];
  if (!lv) return 0;
  const S = DIPD - 2;
  const cx = x + W / 2;
  for (const dp of basinsOf(lv, aisleY)) {
    const R = dp.ramp;
    if (cx <= dp.l - R || cx >= dp.r + R) continue;
    if (cx >= dp.l && cx <= dp.r) return S;
    return cx < dp.l ? (S * (cx - (dp.l - R))) / R : (S * (dp.r + R - cx)) / R;
  }
  return 0;
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
    return { z, id: z + 1, shelfY, lightY: shelfY - 62, basins: new Map<number, Dip[]>(), left: FX };
  });
  return { levels, gnd: BASE_GND + offset, viewH: BASE_VIEW_H + offset };
}

/** A level's own nodes: everything but the dock and the elevator, which have bays of their own */
const onRail = (n: GraphNode) => n.type !== "dock" && n.type !== "elevator";

export function topologyToScene(topology: FarmTopology): Scene {
  const nodes = topology.nodes;
  const zs = Array.from(new Set(nodes.map((n) => n.z))).sort((a, b) => a - b);
  const ys = Array.from(new Set(nodes.map((n) => n.y))).sort((a, b) => a - b);
  const { levels, gnd, viewH } = buildLevels(zs);
  const lvIndex = new Map(levels.map((lv, i) => [lv.z, i]));
  const aisles = (ys.length ? ys : [0]).map((y, i) => ({ y, name: aisleName(i) }));
  const slots = new Map<string, SlotPos>();
  const nodeAisle = new Map<string, number>();

  /** Left edge of topology x's slot: the same on every level */
  const slotL = (x: number) => FX + (x - 1) * SLOT;
  // A level's own nodes left of the design's three grow its shelf out (over
  // the dock bay); nodes right of them, on any level, move the shaft out
  for (const level of levels) {
    const xs = nodes.filter((n) => onRail(n) && n.z === level.z).map((n) => n.x);
    level.left = Math.min(FX, ...xs.map((x) => slotL(Math.floor(x))));
  }
  const xs = nodes.filter(onRail).map((n) => n.x);
  const extraR = xs.length ? Math.max(0, Math.ceil(Math.max(...xs) - BASE_SLOTS)) : 0;
  const ex = EX + extraR * SLOT;
  const viewX = Math.min(0, ...levels.map((lv) => lv.left - DOCK0));
  const frame: Frame = {
    EX: ex,
    ELEV0: ex + ELEV_GAP,
    ELEV1: ex + ELEV_GAP + ELEV_W,
    LANE_X: ex + ELEV_GAP + 5,
    VIEW_X: viewX,
    VIEW_W: ex + ELEV_GAP + ELEV_W + VIEW_PAD - viewX,
  };

  const put = (node: GraphNode, x: number, lv: number) => {
    slots.set(node.id, { nodeId: node.id, type: node.type, x: Math.round(x), y: levels[lv].shelfY - RH, lv, slotW: W });
  };

  for (const node of nodes) {
    nodeAisle.set(node.id, node.y);
    const lv = lvIndex.get(node.z) ?? 0;
    // the charging bay sits off the left end of the lowest level
    if (node.type === "dock") put(node, DOCKX, 0);
    else if (node.type === "elevator") put(node, frame.LANE_X, lv);
    else put(node, slotL(node.x) + (SLOT - W) / 2, lv);
  }

  // A basin under each run of water nodes in neighbouring slots
  for (const aisle of aisles) {
    for (const level of levels) {
      const water = nodes
        .filter((n) => n.y === aisle.y && n.z === level.z && n.type === "water")
        .map((n) => n.x)
        .sort((a, b) => a - b);
      const basins: Dip[] = [];
      let lastX = -Infinity;
      for (const x of water) {
        const r = slotL(x) + SLOT - BASIN_INSET;
        const run = basins[basins.length - 1];
        if (run && x - lastX <= 1) run.r = r;
        else basins.push({ l: slotL(x) + BASIN_INSET, r, y: level.shelfY, b: level.shelfY + DIPD, ramp: RAMP });
        lastX = x;
      }
      level.basins.set(aisle.y, basins);
    }
  }

  return { levels, frame, aisles, gnd, viewH, nodeAisle, slots };
}
