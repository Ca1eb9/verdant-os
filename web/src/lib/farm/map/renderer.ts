// Imperative SVG renderer for the side-view farm map.
//
// The drawing code is ported from the side-view design (Farm_Sideview) with
// its geometry and graphics unchanged. The design's demo logic (timer, random
// targets, fake battery drain) is gone: robots only move when their reported
// node changes, and routes come from the caller.

import { dijkstra, type NavGraph } from "@/lib/farm/navigation";
import {
  DIPD,
  DOCK0,
  DOCK1,
  ELEV0,
  ELEV1,
  EX,
  FX,
  RH,
  TOP,
  VIEW_W,
  W,
  dip,
  levelOf,
  sinkAt,
  type Level,
  type Scene,
  type SlotPos,
} from "@/lib/farm/map/layout";

const NS = "http://www.w3.org/2000/svg";
const FONT = "'Helvetica Neue',Helvetica,Arial,sans-serif";

// ---- per-plant variation lookup (no runtime randomness) ----
// lean: stem control-point offset px | leaf: radii multipliers [lowL, lowR, upL, upR]
// rot: leaf rotation offsets deg | tip: unfurling tip-leaf angles deg
// jx/jy: planting offset px | h: height multiplier
const PLANT_VAR = [
  { lean: 1.8, leaf: [1.12, 1.08, 0.94, 0.9], rot: [3, -4, 5, -2], tip: [-34, 12, 46], jx: 0.6, jy: -0.3, h: 1.04 },
  { lean: -2.4, leaf: [1.1, 1.14, 0.92, 0.88], rot: [-6, 2, -3, 6], tip: [-42, 6, 38], jx: -0.8, jy: 0.4, h: 0.96 },
  { lean: 0.9, leaf: [1.06, 1.02, 0.98, 0.94], rot: [5, 7, -6, 1], tip: [-28, 16, 52], jx: 1.0, jy: 0.2, h: 1.11 },
  { lean: -1.2, leaf: [1.15, 0.98, 0.9, 0.96], rot: [-2, -7, 4, 8], tip: [-38, -4, 30], jx: -0.4, jy: -0.5, h: 0.92 },
  { lean: 2.7, leaf: [1.04, 1.11, 0.96, 0.86], rot: [7, 3, -8, -1], tip: [-46, 10, 44], jx: 0.3, jy: 0.6, h: 1.07 },
  { lean: -0.6, leaf: [1.09, 1.05, 0.88, 0.99], rot: [-4, 6, 2, -5], tip: [-30, 20, 56], jx: -1.1, jy: -0.2, h: 1.0 },
  { lean: 1.4, leaf: [1.13, 1.01, 0.95, 0.91], rot: [1, -3, 7, 4], tip: [-36, 2, 34], jx: 0.7, jy: 0.5, h: 0.94 },
  { lean: -2.9, leaf: [1.07, 1.12, 0.93, 0.87], rot: [-8, 5, -1, 3], tip: [-44, 14, 48], jx: -0.2, jy: -0.6, h: 1.09 },
  { lean: 0.4, leaf: [1.02, 1.09, 0.99, 0.93], rot: [6, -6, 3, -7], tip: [-26, 8, 40], jx: 1.2, jy: 0.1, h: 1.02 },
  { lean: -1.7, leaf: [1.14, 1.03, 0.86, 0.97], rot: [-1, 8, -5, 2], tip: [-40, 18, 50], jx: -0.6, jy: 0.3, h: 0.9 },
  { lean: 2.2, leaf: [1.08, 1.15, 0.91, 0.89], rot: [4, -2, 6, -4], tip: [-32, 4, 36], jx: 0.9, jy: -0.4, h: 1.13 },
  { lean: -0.3, leaf: [1.11, 1.0, 0.97, 0.95], rot: [-7, 1, -2, 7], tip: [-48, 22, 54], jx: -1.0, jy: 0.6, h: 0.98 },
  { lean: 1.1, leaf: [1.05, 1.13, 0.89, 0.92], rot: [2, 4, -7, 5], tip: [-24, -2, 32], jx: 0.4, jy: -0.1, h: 1.05 },
  { lean: -2.6, leaf: [1.03, 1.06, 0.94, 0.98], rot: [-5, -8, 8, -3], tip: [-43, 11, 42], jx: -0.9, jy: 0.2, h: 0.93 },
  { lean: 0.7, leaf: [1.15, 1.04, 0.92, 0.85], rot: [8, 6, 1, -6], tip: [-35, 15, 58], jx: 1.1, jy: 0.4, h: 1.1 },
  { lean: -1.9, leaf: [1.01, 1.1, 0.96, 0.9], rot: [-3, 7, -4, 6], tip: [-29, 0, 28], jx: -0.3, jy: -0.5, h: 1.01 },
  { lean: 2.4, leaf: [1.12, 1.07, 0.87, 0.94], rot: [5, -5, 2, 8], tip: [-47, 19, 45], jx: 0.2, jy: 0.5, h: 0.95 },
  { lean: -0.9, leaf: [1.06, 1.14, 0.98, 0.88], rot: [-6, 3, -8, 1], tip: [-31, 7, 39], jx: -1.2, jy: -0.3, h: 1.08 },
  { lean: 1.6, leaf: [1.09, 1.02, 0.9, 0.96], rot: [7, -1, 4, -2], tip: [-39, 13, 51], jx: 0.8, jy: 0.1, h: 0.91 },
  { lean: -2.1, leaf: [1.13, 1.11, 0.95, 0.86], rot: [-2, 8, -6, 4], tip: [-27, 17, 33], jx: -0.5, jy: 0.6, h: 1.06 },
  { lean: 0.2, leaf: [1.04, 1.08, 0.93, 0.99], rot: [3, -7, 6, 2], tip: [-45, 5, 47], jx: 0.5, jy: -0.6, h: 1.12 },
  { lean: -1.4, leaf: [1.1, 1.05, 0.99, 0.91], rot: [-8, 4, -1, 5], tip: [-33, 21, 37], jx: -0.7, jy: 0.3, h: 0.97 },
];

// ---- palette: muted structure, accents only on robots/status ----
// Text and badge colours are retuned for the dashboard's dark theme; the
// structure, plant, water and light colours are the design's own.
export const PAL = {
  frame: "#6E6A66",
  shelf: "#8A8178",
  shelfLit: "#A79D93",
  shelfDark: "#6B635B",
  tray: "#7A5B44",
  trayEdge: "#5C4231",
  soil: "#4A3526",
  chassisDark: "#4B4642",
  tread: "#3B3733",
  treadLite: "#615B55",
  light: "#8B7FD4",
  lightWarm: "#C9C2F0",
  waterTop: "#7FB0CB",
  waterBot: "#2A5B7D",
  waterLine: "#BFD9E6",
  parked: "#9A938C",
  ink: "#EFF7FF",
  muted: "#88A1B9",
  faint: "#BDB6AE",
  bay: "#C9A227",
  backdrop: "rgba(135, 191, 255, 0.035)",
  badgeFill: "#0B1F2E",
  routeGray: "#7D8791",
  routeLive: "#7FC8B8",
};

const HC = {
  good: { stem: "#3A6B18", leaf: "#5E9224", mid: "#8CBB4E", tip: "#B7D68C" },
  warn: { stem: "#6B4210", leaf: "#AE7318", mid: "#DC9A2A", tip: "#EFC474" },
  bad: { stem: "#6E3115", leaf: "#94401F", mid: "#C85C31", tip: "#E1977B" },
};

export type PlantHealth = keyof typeof HC;
export type RouteStyle = "trail" | "checkpoint";

export interface RobotDraw {
  id: string;
  nodeId: string | null;
  /** Badge text, e.g. "Moving", "Watering" */
  action: string;
  battery: number;
  health: PlantHealth;
  growth: number;
  /** Under the grow lights (draw the lit canopy) */
  lit: boolean;
}

export interface RouteDraw {
  /** Key that identifies one planned route (changes when a new command is sent) */
  key: string;
  nodes: string[];
  /** Index into nodes of the robot's last confirmed node */
  progress: number;
  /** "preview" = not yet sent (target picked in the form) */
  mode: "preview" | "active";
  /** Robot is actively driving the next segment */
  moving: boolean;
}

export interface RenderInput {
  scene: Scene;
  graph: NavGraph;
  aisleY: number;
  robots: RobotDraw[];
  selectedId: string | null;
  targetNodeId: string | null;
  /** Nodes the operator may pick as a target */
  targetable: Set<string>;
  route: RouteDraw | null;
  routeStyle: RouteStyle;
}

export interface RendererOptions {
  accent?: string;
  beamOpacity?: number;
  showBeams?: boolean;
  onNodeClick?: (nodeId: string) => void;
  onRobotClick?: (robotId: string) => void;
}

interface RobotAnim {
  x: number;
  y: number;
  queue: { x: number; y: number }[];
  anim: boolean;
  nodeId: string | null;
  /** Reported node is outside the aisle being viewed */
  hidden: boolean;
}

type Attrs = Record<string, string | number>;

export class FarmRenderer {
  private svg: SVGSVGElement;
  private opts: RendererOptions;
  private input: RenderInput | null = null;
  private staticKey = "";
  private robotState = new Map<string, RobotAnim>();
  private slotLayer: SVGGElement | null = null;
  private routeLayer: SVGGElement | null = null;
  private fadeLayer: SVGGElement | null = null;
  private trailLayer: SVGGElement | null = null;
  private robotLayer: SVGGElement | null = null;
  private labelLayer: SVGGElement | null = null;
  private routeProgress = new Map<string, number>();
  private destroyed = false;

  constructor(svg: SVGSVGElement, opts: RendererOptions = {}) {
    this.svg = svg;
    this.opts = opts;
  }

  setOptions(opts: RendererOptions) {
    const redraw =
      opts.accent !== this.opts.accent ||
      opts.beamOpacity !== this.opts.beamOpacity ||
      opts.showBeams !== this.opts.showBeams;
    this.opts = opts;
    if (redraw && this.input) {
      this.staticKey = "";
      this.render(this.input);
    }
  }

  destroy() {
    this.destroyed = true;
    this.svg.innerHTML = "";
  }

  // ---------- tiny helpers ----------
  private mk<K extends keyof SVGElementTagNameMap>(tag: K, a: Attrs, p?: Element | null): SVGElementTagNameMap[K] {
    const e = document.createElementNS(NS, tag) as SVGElementTagNameMap[K];
    for (const k in a) e.setAttribute(k, String(a[k]));
    if (p) p.appendChild(e);
    return e;
  }

  private mkT(t: string, a: Attrs, p?: Element | null) {
    const e = this.mk("text", a, p);
    e.textContent = t;
    return e;
  }

  private accent() {
    return this.opts.accent || "#D9722E";
  }

  private get levels(): Level[] {
    return this.input?.scene.levels ?? [];
  }

  // ---------- public render ----------
  render(input: RenderInput) {
    if (this.destroyed) return;
    const prev = this.input;
    this.input = input;
    const key = `${input.aisleY}|${input.scene.viewH}|${[...input.scene.slots.keys()].join(",")}`;

    if (key !== this.staticKey || !prev || prev.scene !== input.scene) {
      this.staticKey = key;
      this.drawFarm();
      this.syncRobots(input, true);
    } else {
      this.syncRobots(input, false);
    }
    this.drawSlots();
    this.drawRoute();
    this.drawRobots();
  }

  // ---------- position helpers ----------
  private slotInView(nodeId: string | null): SlotPos | null {
    if (!nodeId || !this.input) return null;
    const { scene, aisleY } = this.input;
    if (scene.nodeAisle.get(nodeId) !== aisleY) return null;
    return scene.slots.get(nodeId) ?? null;
  }

  private occupied(): Set<string> {
    const set = new Set<string>();
    for (const r of this.input?.robots ?? []) if (r.nodeId) set.add(r.nodeId);
    return set;
  }

  /** Bring each robot's drawn position in line with its reported node */
  private syncRobots(input: RenderInput, snap: boolean) {
    const seen = new Set<string>();
    for (const robot of input.robots) {
      seen.add(robot.id);
      const slot = this.slotInView(robot.nodeId);
      let st = this.robotState.get(robot.id);

      if (!st || snap || (st.hidden && slot)) {
        st = { x: slot?.x ?? 0, y: slot?.y ?? 0, queue: [], anim: false, nodeId: robot.nodeId, hidden: !slot };
        this.robotState.set(robot.id, st);
        continue;
      }
      if (!slot) {
        st.nodeId = robot.nodeId;
        st.queue = [];
        st.hidden = !st.anim;
        continue;
      }
      if (st.nodeId === robot.nodeId) continue;

      // node changed: drive along the graph path between the two nodes
      const from = st.nodeId;
      st.nodeId = robot.nodeId;
      const path = from && robot.nodeId ? dijkstra(input.graph, from, robot.nodeId) : null;
      const hops = (path ?? [robot.nodeId as string]).slice(path ? 1 : 0);
      for (const id of hops) {
        const s = this.slotInView(id);
        if (s) st.queue.push({ x: s.x, y: s.y });
      }
      if (!st.queue.length) st.queue.push({ x: slot.x, y: slot.y });
      this.processQueue(robot.id);
    }
    for (const id of [...this.robotState.keys()]) if (!seen.has(id)) this.robotState.delete(id);
  }

  // ---------- motion ----------
  private processQueue(id: string) {
    const st = this.robotState.get(id);
    if (!st || st.anim) return;
    const next = st.queue.shift();
    if (!next) {
      this.drawRobots();
      return;
    }
    this.animTo(id, next.x, next.y, () => {
      if (st.queue.length) window.setTimeout(() => this.processQueue(id), 200);
      else this.drawRobots();
    });
  }

  private animTo(id: string, tx: number, ty: number, cb: () => void) {
    const st = this.robotState.get(id);
    if (!st) return;
    st.anim = true;
    const sx = st.x;
    const sy = st.y;
    const dx = tx - sx;
    const dy = ty - sy;
    this.addTrail(sx, sy, tx, ty);
    const dur = Math.max(250, Math.sqrt(dx * dx + dy * dy) * 3.5);
    let start: number | null = null;
    const frame = (ts: number) => {
      if (this.destroyed || this.robotState.get(id) !== st) return;
      if (start === null) start = ts;
      const p = Math.min(1, (ts - start) / dur);
      const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
      st.x = sx + dx * e;
      st.y = sy + dy * e;
      this.drawRobots();
      if (p < 1) requestAnimationFrame(frame);
      else {
        st.anim = false;
        cb();
      }
    };
    requestAnimationFrame(frame);
  }

  // faint dotted breadcrumb of the segment just travelled, fading out over ~3s
  private addTrail(sx: number, sy: number, tx: number, ty: number) {
    if (!this.trailLayer) return;
    const h = W / 2;
    const seg = this.mk(
      "line",
      {
        x1: sx + h, y1: sy + 10, x2: tx + h, y2: ty + 10,
        stroke: this.accent(), "stroke-width": 1.2, "stroke-dasharray": "2 5", "stroke-linecap": "round",
        opacity: 0.5, style: "animation:fwTrail 3s linear forwards",
      },
      this.trailLayer,
    );
    const end = this.mk(
      "circle",
      { cx: tx + h, cy: ty + 10, r: 2.8, fill: this.accent(), opacity: 0.5, style: "animation:fwTrail 3s linear forwards" },
      this.trailLayer,
    );
    window.setTimeout(() => {
      seg.remove();
      end.remove();
    }, 3200);
  }

  // ---------- defs ----------
  private defs(svg: SVGSVGElement) {
    const P = PAL;
    const d = this.mk("defs", {}, svg);
    const style = this.mk("style", {}, d);
    style.textContent =
      "@keyframes activePulse{0%,100%{opacity:1}50%{opacity:.5}}" +
      "@keyframes fwTrail{from{opacity:.5}to{opacity:0}}" +
      "@keyframes fwSegFade{from{opacity:.9}to{opacity:0}}" +
      "@keyframes fwSegBlink{0%,100%{opacity:.95}50%{opacity:.25}}" +
      ".fw-hidden{opacity:0}" +
      ".fw-slot:hover .fw-outline{opacity:1;stroke:" + this.accent() + ";fill:" + this.accent() + ";fill-opacity:.06}" +
      "@media (prefers-reduced-motion:reduce){[style*=animation]{animation:none!important}}";
    const wg = this.mk("linearGradient", { id: "fw-water", x1: 0, y1: 0, x2: 0, y2: 1 }, d);
    this.mk("stop", { offset: "0%", "stop-color": P.waterTop, "stop-opacity": 0.45 }, wg);
    this.mk("stop", { offset: "55%", "stop-color": P.waterTop, "stop-opacity": 0.62 }, wg);
    this.mk("stop", { offset: "100%", "stop-color": P.waterBot, "stop-opacity": 0.88 }, wg);
    const bg = this.mk("linearGradient", { id: "fw-beam", x1: 0, y1: 0, x2: 0, y2: 1 }, d);
    this.mk("stop", { offset: "0%", "stop-color": P.light, "stop-opacity": 0.38 }, bg);
    this.mk("stop", { offset: "100%", "stop-color": P.light, "stop-opacity": 0 }, bg);
    this.levels.forEach((lv, i) => {
      const dp = dip(lv);
      const cp = this.mk("clipPath", { id: "fw-chan-" + i }, d);
      this.mk("rect", { x: dp.l - dp.ramp, y: dp.y + 2, width: dp.r + dp.ramp - (dp.l - dp.ramp), height: DIPD }, cp);
    });
  }

  // ---------- drawPlant: curved stem, table-driven leaf variation, unfurling growing tip ----------
  private drawPlant(
    p: Element,
    x: number,
    baseY: number,
    health: PlantHealth,
    growth: number,
    opts: { scale?: number; idx?: number; lean?: number; dim?: number; stemParent?: Element; thinLow?: boolean; thinLow2?: boolean },
  ) {
    const c = HC[health] || HC.good;
    const sc = opts.scale == null ? 1 : opts.scale;
    const V = PLANT_VAR[(opts.idx == null ? 0 : opts.idx) % PLANT_VAR.length];
    const h = growth * 28 * V.h * sc;
    const lean = V.lean;
    const v = sc * 0.95;
    const transform =
      "translate(" + x.toFixed(1) + "," + baseY.toFixed(1) + ")" + (opts.lean ? " rotate(" + opts.lean.toFixed(1) + ")" : "");
    const ga: Attrs = { transform };
    if (opts.dim) ga.opacity = opts.dim;
    const g = this.mk("g", ga, p);
    this.mk(
      "path",
      {
        d: "M0 0 Q " + (lean * 1.7).toFixed(1) + " " + (-h * 0.55).toFixed(1) + " " + (lean * 0.8).toFixed(1) + " " + (-h).toFixed(1),
        fill: "none", stroke: c.stem, "stroke-width": 1.4, "stroke-linecap": "round",
      },
      opts.stemParent ? this.mk("g", { transform }, opts.stemParent) : g,
    );
    const lf = (cx: number, cy: number, rx: number, ry: number, fill: string, rot: number) =>
      this.mk(
        "ellipse",
        {
          cx: cx.toFixed(1), cy: cy.toFixed(1), rx: rx.toFixed(1), ry: ry.toFixed(1), fill,
          transform: "rotate(" + rot.toFixed(0) + " " + cx.toFixed(1) + " " + cy.toFixed(1) + ")",
        },
        g,
      );
    // stem point at parameter t, so every leaf is anchored on the curve it grows from
    const bez = (t: number) => {
      const m = 1 - t;
      return { x: 2 * m * t * lean * 1.7 + t * t * lean * 0.8, y: -(2 * m * t * h * 0.55 + t * t * h) };
    };
    const leafAt = (t: number, dir: number, mul: number, rx0: number, ry0: number, fill: string, rot: number) => {
      const s = bez(t);
      const rx = rx0 * v * mul;
      const ry = ry0 * v * mul;
      lf(s.x + dir * rx * 0.88, s.y, rx, ry, fill, rot);
    };
    if (h > 8) {
      if (!opts.thinLow) leafAt(0.32, -1, V.leaf[0], 4.2, 2.1, c.leaf, -32 + V.rot[0]);
      if (!opts.thinLow2) leafAt(0.47, 1, V.leaf[1], 3.9, 2.0, c.leaf, 28 + V.rot[1]);
    }
    if (h > 15) {
      leafAt(0.68, -1, V.leaf[2], 3.3, 1.9, c.mid, -22 + V.rot[2]);
      leafAt(0.83, 1, V.leaf[3], 3.0, 1.8, c.mid, 18 + V.rot[3]);
    }
    // growing tip: 2-3 tiny unfurling leaves clustered on the stem apex
    if (h > 19) {
      const tip = bez(1);
      const tx = tip.x;
      const ty = tip.y + 0.6;
      V.tip.forEach((ang, i) => {
        const rad = (ang * Math.PI) / 180;
        const r = 1.6 + i * 0.3;
        lf(tx + Math.sin(rad) * r, ty - Math.cos(rad) * r * 0.5, 2.5 * v * 0.6, 1.3 * v * 0.6, c.tip, ang);
      });
    }
  }

  // every rover grows the same canopy graphic: table-driven variation, two rows fanning outward
  private drawCanopy(p: Element, cx: number, baseY: number, w: number, health: PlantHealth, stemLayer: Element) {
    const inner = w - 15;
    const nB = 6;
    const nF = 7;
    const row = (n: number, i: number) => (n <= 1 ? cx : cx - inner / 2 + (inner / (n - 1)) * i);
    // thin out ~25% of the darker lower leaves, weighted to the left of the tray
    const thinBack = [0, 1, 4];
    const thinFront = [0, 2, 6];
    const thinBack2 = [0, 3];
    const thinFront2 = [1, 4, 5];
    for (let i = 0; i < nB; i++) {
      const bx = row(nB, i);
      const t = (bx - cx) / (inner / 2);
      const V = PLANT_VAR[i % PLANT_VAR.length];
      this.drawPlant(p, bx + V.jx, baseY + 0.5 + V.jy, health, 0.62, {
        idx: i, scale: 0.8, dim: 0.76, lean: t * 11 + V.lean, stemParent: stemLayer,
        thinLow: thinBack.includes(i), thinLow2: thinBack2.includes(i),
      });
    }
    for (let k = 0; k < nF; k++) {
      const fx = row(nF, k);
      const tf = (fx - cx) / (inner / 2);
      const V = PLANT_VAR[(k + nB) % PLANT_VAR.length];
      this.drawPlant(p, fx + V.jx, baseY + 3 + V.jy, health, 0.82, {
        idx: k + nB, scale: 1, lean: tf * 9 + V.lean, stemParent: stemLayer,
        thinLow: thinFront.includes(k), thinLow2: thinFront2.includes(k),
      });
    }
  }

  // ---------- drawShelf: C-channel rail with a central \__/ water basin ----------
  private drawShelf(p: Element, lv: Level) {
    const P = PAL;
    const t = 6;
    const dp = dip(lv);
    const R = dp.ramp;
    const y = lv.shelfY;
    const b = dp.b;
    const g = this.mk("g", {}, p);
    const top = "M" + FX + " " + y + " L" + (dp.l - R) + " " + y + " L" + dp.l + " " + b + " L" + dp.r + " " + b + " L" + (dp.r + R) + " " + y + " L" + EX + " " + y;
    const web =
      top + " L" + EX + " " + (y + t) + " L" + (dp.r + R + t * 0.7) + " " + (y + t) + " L" + (dp.r + t * 0.5) + " " + (b + t) +
      " L" + (dp.l - t * 0.5) + " " + (b + t) + " L" + (dp.l - R - t * 0.7) + " " + (y + t) + " L" + FX + " " + (y + t) + " Z";
    this.mk("path", { d: web, fill: P.shelf }, g);
    this.mk("path", { d: top, fill: "none", stroke: P.shelfLit, "stroke-width": 1.3 }, g);
    // C-channel return flanges at both ends + gussets: reads as load-bearing rail
    this.mk("path", { d: "M" + FX + " " + y + " L" + (FX + 9) + " " + y + " L" + (FX + 9) + " " + (y + t + 7) + " L" + FX + " " + (y + t + 7) + " Z", fill: P.shelfDark }, g);
    this.mk("path", { d: "M" + (EX - 9) + " " + y + " L" + EX + " " + y + " L" + EX + " " + (y + t + 7) + " L" + (EX - 9) + " " + (y + t + 7) + " Z", fill: P.shelfDark }, g);
    this.mk("path", { d: "M" + (dp.l - R) + " " + y + " L" + dp.l + " " + b + " M" + (dp.r + R) + " " + y + " L" + dp.r + " " + b, fill: "none", stroke: P.shelfDark, "stroke-width": 0.9, opacity: 0.55 }, g);
    for (let bx = FX + 26; bx < EX - 14; bx += 62) {
      if (bx > dp.l - R - 20 && bx < dp.r + R + 20) continue;
      this.mk("path", { d: "M" + bx + " " + (y + t) + " l6 0 l-6 9 Z", fill: P.shelfDark, opacity: 0.45 }, g);
    }
    this.mkT("L" + lv.id, { x: FX + 6, y: y - 24, "text-anchor": "start", "font-size": "11px", fill: P.muted, "font-family": FONT, "font-weight": "500" }, g);
  }

  // ---------- drawWater: basin body (before rovers) + surface (after) ----------
  private drawWater(p: Element, lv: Level) {
    const P = PAL;
    const dp = dip(lv);
    const R = dp.ramp;
    const sy = dp.y + 3;
    const inset = R * (3 / DIPD);
    const g = this.mk("g", {}, p);
    this.mk("path", { d: "M" + (dp.l - R + inset) + " " + sy + " L" + dp.l + " " + dp.b + " L" + dp.r + " " + dp.b + " L" + (dp.r + R - inset) + " " + sy + " Z", fill: "url(#fw-water)" }, g);
    this.mk("path", { d: "M" + dp.l + " " + (dp.b - 1.4) + " L" + dp.r + " " + (dp.b - 1.4), fill: "none", stroke: P.waterBot, "stroke-width": 1.6, opacity: 0.5 }, g);
  }

  private drawWaterVeil(p: Element, lv: Level, li: number) {
    const dp = dip(lv);
    const R = dp.ramp;
    const sy = dp.y + 2;
    const inset = R * (2 / DIPD);
    const g = this.mk("g", { "clip-path": "url(#fw-chan-" + li + ")" }, p);
    this.mk("path", { d: "M" + (dp.l - R + inset) + " " + sy + " L" + dp.l + " " + dp.b + " L" + dp.r + " " + dp.b + " L" + (dp.r + R - inset) + " " + sy + " Z", fill: "url(#fw-water)", opacity: 0.55 }, g);
  }

  private drawWaterSurface(p: Element, lv: Level, li: number, phase: number) {
    const P = PAL;
    const dp = dip(lv);
    const x0 = dp.l - dp.ramp;
    const x1 = dp.r + dp.ramp;
    const y = dp.y + 1;
    const g = this.mk("g", { "clip-path": "url(#fw-chan-" + li + ")" }, p);
    const waves = [
      { dy: 2.2, amp: 1.2, len: 30, op: 0.8, w: 0.9 },
      { dy: 4.4, amp: 0.9, len: 22, op: 0.45, w: 0.7 },
      { dy: 6.6, amp: 0.7, len: 38, op: 0.25, w: 0.6 },
    ];
    waves.forEach((wv, i) => {
      let d = "M" + x0 + " " + (y + wv.dy);
      for (let x = x0; x < x1 + wv.len; x += wv.len) {
        const half = wv.len / 2;
        d += " q " + half / 2 + " " + -wv.amp + " " + half + " 0 q " + half / 2 + " " + wv.amp + " " + half + " 0";
      }
      this.mk("path", { d, fill: "none", stroke: P.waterLine, "stroke-width": wv.w, opacity: wv.op, "stroke-linecap": "round", transform: "translate(" + (((phase + i * 7) % wv.len) - wv.len) + ",0)" }, g);
    });
  }

  // ---------- drawLights: bar + soft fanning beams ----------
  private drawLights(p: Element, lightY: number, shelfY: number) {
    const P = PAL;
    const x0 = FX + 6;
    const x1 = EX - 6;
    const g = this.mk("g", {}, p);
    const span = shelfY - (lightY + 5);
    if (this.opts.showBeams !== false) {
      const op = this.opts.beamOpacity == null ? 0.32 : this.opts.beamOpacity;
      const bg = this.mk("g", { opacity: op }, g);
      for (let bx = x0 + 24; bx < x1 - 10; bx += 48) {
        const spread = span * 0.46;
        this.mk("path", { d: "M" + (bx - 5) + " " + (lightY + 5) + " L" + (bx - spread) + " " + shelfY + " L" + (bx + spread) + " " + shelfY + " L" + (bx + 5) + " " + (lightY + 5) + " Z", fill: "url(#fw-beam)" }, bg);
      }
    }
    this.mk("rect", { x: x0, y: lightY, width: x1 - x0, height: 5, fill: P.light, rx: 2 }, g);
    this.mk("rect", { x: x0, y: lightY, width: x1 - x0, height: 1.2, fill: "#A79CE4", rx: 1 }, g);
    for (let lx = x0 + 10; lx < x1 - 6; lx += 23) this.mk("rect", { x: lx, y: lightY + 5, width: 9, height: 1.6, fill: P.lightWarm, opacity: 0.7, rx: 0.8 }, g);
  }

  // ---------- drawRobot: 4-wheel rover — 3/4 soil tray, 1/4 electronics box ----------
  private drawRobot(
    p: Element,
    x: number,
    ty: number,
    data: RobotDraw,
    opts: { active: boolean; selected: boolean; labelLayer: Element; labelY: number },
  ) {
    const P = PAL;
    const w = W;
    const body = opts.active ? this.accent() : P.parked;
    const trayW = Math.round(w * 0.75);
    const boxX = trayW + 1;
    const g = this.mk("g", { transform: "translate(" + Math.round(x) + "," + Math.round(ty) + ")", "data-robot": data.id, style: "cursor:pointer" }, p);
    if (!opts.active) g.setAttribute("opacity", "0.82");
    const title = this.mk("title", {}, g);
    title.textContent = data.id + " · " + data.action;
    // hit area covering antenna to wheels
    this.mk("rect", { x: -3, y: -23, width: w + 6, height: 42, fill: "transparent" }, g);

    // wheels: one pair at the front, one at the back, tucked under the chassis edges
    this.mk("circle", { cx: 5, cy: 12.5, r: 4.5, fill: P.tread }, g);
    this.mk("circle", { cx: w - 5, cy: 12.5, r: 4.5, fill: P.tread }, g);
    // soil tray: recessed halfway into the chassis, drawn behind it
    const stemLayer = this.mk("g", {}, g); // stems render behind the tray front wall
    this.mk("rect", { x: 2, y: -5, width: trayW - 2, height: 10, fill: P.tray, rx: 1.5 }, g);
    this.mk("rect", { x: 2, y: -5, width: trayW - 2, height: 2.6, fill: P.soil, opacity: 0.9, rx: 1 }, g);
    this.mk("rect", { x: 2, y: -5, width: trayW - 2, height: 10, fill: "none", stroke: P.trayEdge, "stroke-width": 0.7, rx: 1.5 }, g);
    // chassis: low-profile deck with a bevelled nose
    this.mk("path", { d: "M0 3 L3 0 L" + (w - 3) + " 0 L" + w + " 3 L" + w + " 9 L0 9 Z", fill: body }, g);
    this.mk("rect", { x: 3, y: 1, width: w - 6, height: 1.3, fill: "#FFFFFF", opacity: opts.active ? 0.34 : 0.2, rx: 0.65 }, g);
    // electronics box: controller + battery, top flush with the tray rim
    this.mk("rect", { x: boxX, y: -5, width: w - boxX - 1, height: 14, fill: P.chassisDark, rx: 1.5 }, g);
    this.mk("rect", { x: boxX + 2, y: -2.6, width: w - boxX - 5, height: 2, fill: P.treadLite, opacity: 0.9, rx: 1 }, g);
    this.mk("rect", { x: boxX + 2, y: 2.6, width: 5, height: 4, fill: body, rx: 1 }, g);
    // antenna
    this.mk("path", { d: "M" + (w - 5) + " -5 L" + (w - 5) + " -17 l3 -3", fill: "none", stroke: body, "stroke-width": 1.4, "stroke-linecap": "round" }, g);
    this.mk("circle", { cx: w - 2, cy: -20, r: opts.active ? 2.6 : 2, fill: body, ...(opts.active ? { style: "animation:activePulse 1.2s infinite" } : {}) }, g);

    this.drawCanopy(g, trayW / 2 + 1, -5, trayW, data.health, stemLayer);

    // selection: dashed outline around the rover
    if (opts.selected) {
      this.mk("rect", { x: -4, y: -25, width: w + 8, height: 46, rx: 4, fill: "none", stroke: this.accent(), "stroke-width": 1, "stroke-dasharray": "4 3", opacity: 0.9 }, g);
    }

    // floating status badge: action text + a literal battery glyph and its percentage
    if (opts.active) {
      const ac = this.accent();
      const bw = 98;
      const bh = 14;
      const by = -48;
      const pct = Math.round(Math.max(0, Math.min(100, data.battery)));
      // keep the pill inside the viewBox at the dock and the elevator lane
      const bx = Math.round(Math.min(Math.max(3 - x, trayW / 2 + 1 - bw / 2), VIEW_W - 3 - bw - x));
      const gx = bx + bw - 42;
      const gy = by + 3.8;
      this.mk("rect", { x: bx, y: by, width: bw, height: bh, rx: 7, fill: P.badgeFill, stroke: ac, "stroke-width": 0.8, opacity: 0.96 }, g);
      this.mkT(data.action, { x: bx + 9, y: by + 9.6, "font-size": "9.5px", fill: ac, "font-weight": "500", "font-family": FONT }, g);
      this.mk("rect", { x: gx, y: gy, width: 15, height: 6.8, rx: 1.3, fill: "none", stroke: ac, "stroke-width": 0.9 }, g);
      this.mk("rect", { x: gx + 15.5, y: gy + 2, width: 2, height: 3, rx: 0.6, fill: ac }, g);
      this.mk("rect", { x: gx + 1.3, y: gy + 1.3, width: Math.max(1.1, (12.4 * pct) / 100), height: 4.2, rx: 0.6, fill: ac }, g);
      this.mkT(pct + "%", { x: bx + bw - 7, y: by + 9.5, "text-anchor": "end", "font-size": "7.2px", fill: ac, "font-family": FONT }, g);
    }

    this.mkT(data.id, {
      x: Math.round(x) + w / 2, y: opts.labelY, "text-anchor": "middle", "font-size": "10px",
      fill: opts.active ? this.accent() : P.muted, "font-family": FONT, "font-weight": opts.active ? "500" : "400",
    }, opts.labelLayer);

    g.addEventListener("click", (event) => {
      event.stopPropagation();
      this.opts.onRobotClick?.(data.id);
    });
  }

  // ---------- drawDock: wall + pogo contacts at the far left, rover pad to their right ----------
  private drawDock(p: Element) {
    const P = PAL;
    const x0 = DOCK0;
    const x1 = DOCK1;
    const y = this.levels[0].shelfY;
    const gnd = this.input!.scene.gnd;
    const g = this.mk("g", { "pointer-events": "none" }, p);
    this.mk("rect", { x: x0, y: y - 52, width: x1 - x0, height: gnd - (y - 52), fill: P.bay, opacity: 0.1, rx: 3 }, g);
    this.mk("rect", { x: x0, y: y - 52, width: 9, height: gnd - (y - 52), fill: P.frame }, g); // wall
    this.mk("rect", { x: x0, y, width: x1 - x0, height: 6, fill: P.shelf }, g); // dock floor
    this.mk("rect", { x: x0 + 9, y: y - 20, width: 9, height: 14, fill: P.bay, rx: 1.5 }, g); // pogo block
    this.mk("rect", { x: x0 + 18, y: y - 17, width: 5, height: 2, fill: P.bay, rx: 1 }, g); // pogo pins
    this.mk("rect", { x: x0 + 18, y: y - 12, width: 5, height: 2, fill: P.bay, rx: 1 }, g);
    this.mk("path", { d: "M" + (x0 + 43) + " " + (y - 44) + " l-5 9 h4 l-3.5 8 l9 -11 h-4 l4 -6 Z", fill: P.bay }, g);
    this.mkT("Charge", { x: (x0 + x1) / 2, y: gnd + 14, "text-anchor": "middle", "font-size": "10px", fill: P.muted, "font-family": FONT }, g);
  }

  private drawElevator(p: Element) {
    const P = PAL;
    const x0 = ELEV0;
    const x1 = ELEV1;
    const gnd = this.input!.scene.gnd;
    const g = this.mk("g", { "pointer-events": "none" }, p);
    this.mk("rect", { x: x0, y: TOP, width: x1 - x0, height: gnd - TOP, fill: P.bay, opacity: 0.1, rx: 3 }, g);
    this.mk("rect", { x: x1 - 9, y: TOP, width: 9, height: gnd - TOP, fill: P.frame }, g); // shaft wall
    this.mk("line", { x1: x0, y1: TOP, x2: x0, y2: gnd, stroke: P.bay, "stroke-width": 0.9, opacity: 0.45 }, g);
    for (let ey = TOP + 8; ey < gnd; ey += 16) this.mk("line", { x1: x0 + 8, y1: ey, x2: x1 - 13, y2: ey, stroke: P.bay, "stroke-width": 0.5, opacity: 0.22 }, g);
    this.mkT("Elevator", { x: (x0 + x1) / 2, y: gnd + 14, "text-anchor": "middle", "font-size": "10px", fill: P.muted, "font-family": FONT }, g);
  }

  // ---------- scene ----------
  private drawFarm() {
    const svg = this.svg;
    const input = this.input!;
    const P = PAL;
    const gnd = input.scene.gnd;
    svg.innerHTML = "";
    svg.setAttribute("viewBox", `0 0 ${VIEW_W} ${input.scene.viewH}`);
    this.defs(svg);

    this.mk("rect", { x: FX, y: TOP, width: EX - FX, height: gnd - TOP, fill: P.backdrop }, svg);

    this.levels.forEach((lv, li) => {
      this.drawLights(svg, lv.lightY, lv.shelfY);
      this.drawWater(svg, lv);
      this.drawWaterSurface(svg, lv, li, (lv.shelfY * 0.7) % 30); // wave lines sit behind the shelf structure
      this.drawShelf(svg, lv);
    });

    this.slotLayer = this.mk("g", {}, svg);
    this.routeLayer = this.mk("g", { "pointer-events": "none" }, svg);
    this.fadeLayer = this.mk("g", { "pointer-events": "none" }, svg);
    this.trailLayer = this.mk("g", { "pointer-events": "none" }, svg); // path trail sits under the rovers
    this.robotLayer = this.mk("g", {}, svg);

    // translucent veil over whatever is in the basin, so a rover reads as sitting in the water
    const veil = this.mk("g", { "pointer-events": "none" }, svg);
    this.levels.forEach((lv, li) => this.drawWaterVeil(veil, lv, li));
    this.labelLayer = this.mk("g", { "pointer-events": "none" }, svg);

    const frame = this.mk("g", { "pointer-events": "none" }, svg);
    this.mk("line", { x1: FX, y1: TOP, x2: FX, y2: gnd, stroke: P.frame, "stroke-width": 1.6 }, frame);
    this.mk("line", { x1: EX, y1: TOP, x2: EX, y2: gnd, stroke: P.frame, "stroke-width": 1.6 }, frame);
    this.mk("rect", { x: DOCK0, y: gnd, width: ELEV1 - DOCK0, height: 4, fill: P.frame, rx: 1 }, frame);
    this.drawDock(svg);
    this.drawElevator(svg);
    this.routeProgress.clear();
  }

  // ---------- slots: empty-slot outlines + click targets ----------
  private drawSlots() {
    const layer = this.slotLayer;
    const input = this.input;
    if (!layer || !input) return;
    layer.innerHTML = "";
    const occupied = this.occupied();

    for (const slot of input.scene.slots.values()) {
      if (input.scene.nodeAisle.get(slot.nodeId) !== input.aisleY) continue;
      const pickable = input.targetable.has(slot.nodeId);
      const isTarget = input.targetNodeId === slot.nodeId;
      const sink = sinkAt(this.levels, slot.x, slot.lv);
      const ox = slot.x + (W - slot.slotW) / 2;
      const g = this.mk("g", { "data-node": slot.nodeId, class: pickable ? "fw-slot" : "", style: pickable ? "cursor:pointer" : "" }, layer);
      const title = this.mk("title", {}, g);
      title.textContent = slot.nodeId;

      if (slot.type !== "elevator") {
        // occupied slots keep an invisible outline that still lights up on hover
        const hidden = occupied.has(slot.nodeId) && !isTarget;
        this.mk("rect", {
          class: "fw-outline" + (hidden ? " fw-hidden" : ""),
          x: ox, y: slot.y - 5 + sink, width: slot.slotW, height: 22, rx: 2,
          fill: isTarget ? this.accent() : "none", "fill-opacity": isTarget ? 0.12 : 0,
          stroke: isTarget ? this.accent() : PAL.faint, "stroke-width": isTarget ? 1.2 : 1,
          "stroke-dasharray": "3 3", opacity: isTarget ? 1 : 0.8,
        }, g);
      }
      if (pickable) {
        const hit = this.mk("rect", { class: "fw-hit", x: ox - 2, y: slot.y - 26 + sink, width: slot.slotW + 4, height: 46, fill: "transparent" }, g);
        hit.addEventListener("click", () => this.opts.onNodeClick?.(slot.nodeId));
      }
    }
  }

  // ---------- route ----------
  private point(nodeId: string) {
    const s = this.slotInView(nodeId);
    return s ? { x: s.x + W / 2, y: s.y + 10 } : null;
  }

  private segment(p: Element, a: string, b: string, attrs: Attrs) {
    const pa = this.point(a);
    const pb = this.point(b);
    if (!pa || !pb || (pa.x === pb.x && pa.y === pb.y)) return;
    this.mk("line", { x1: pa.x, y1: pa.y, x2: pb.x, y2: pb.y, "stroke-linecap": "round", ...attrs }, p);
  }

  private drawRoute() {
    const layer = this.routeLayer;
    const input = this.input;
    if (!layer || !input) return;
    layer.innerHTML = "";
    const route = input.route;
    if (!route || route.nodes.length < 2) return;
    const nodes = route.nodes;
    const accent = this.accent();

    if (route.mode === "preview") {
      for (let i = 0; i < nodes.length - 1; i++) {
        this.segment(layer, nodes[i], nodes[i + 1], { stroke: accent, "stroke-width": 1.4, "stroke-dasharray": "3 4", opacity: 0.55 });
      }
      const end = this.point(nodes[nodes.length - 1]);
      if (end) this.mk("circle", { cx: end.x, cy: end.y, r: 3, fill: accent, opacity: 0.6 }, layer);
      return;
    }

    const progress = Math.max(0, Math.min(route.progress, nodes.length - 1));

    if (input.routeStyle === "trail") {
      // remaining route as a faint dashed line; travelled hops leave the design's fading trail
      for (let i = progress; i < nodes.length - 1; i++) {
        this.segment(layer, nodes[i], nodes[i + 1], { stroke: accent, "stroke-width": 1.2, "stroke-dasharray": "2 5", opacity: 0.45 });
      }
      const end = this.point(nodes[nodes.length - 1]);
      if (end) this.mk("circle", { cx: end.x, cy: end.y, r: 2.8, fill: accent, opacity: 0.55 }, layer);
      this.routeProgress.set(route.key, progress);
      return;
    }

    // checkpoint style: whole estimate grayed out, the segment being driven
    // blinks, and a confirmed segment fades out once the robot reports the node
    const last = this.routeProgress.get(route.key);
    if (last !== undefined && progress > last && this.fadeLayer) {
      const fade = this.mk("g", { style: "animation:fwSegFade 3s linear forwards" }, this.fadeLayer);
      for (let i = last; i < progress; i++) {
        this.segment(fade, nodes[i], nodes[i + 1], { stroke: PAL.routeLive, "stroke-width": 2.2 });
      }
      window.setTimeout(() => fade.remove(), 3200);
    }
    this.routeProgress.set(route.key, progress);

    for (let i = progress; i < nodes.length - 1; i++) {
      const live = i === progress && route.moving;
      this.segment(layer, nodes[i], nodes[i + 1], live
        ? { stroke: PAL.routeLive, "stroke-width": 2.2, style: "animation:fwSegBlink 1.1s ease-in-out infinite" }
        : { stroke: PAL.routeGray, "stroke-width": 2, opacity: 0.5 });
    }
    for (let i = progress + 1; i < nodes.length; i++) {
      const pt = this.point(nodes[i]);
      if (pt) this.mk("circle", { cx: pt.x, cy: pt.y, r: i === nodes.length - 1 ? 3 : 2.2, fill: PAL.routeGray, opacity: 0.7 }, layer);
    }
  }

  // ---------- robots ----------
  private drawRobots() {
    const layer = this.robotLayer;
    const labels = this.labelLayer;
    const input = this.input;
    if (!layer || !labels || !input) return;
    layer.innerHTML = "";
    labels.innerHTML = "";
    // selected robot draws last so it sits on top
    const ordered = [...input.robots].sort((a, b) => Number(a.id === input.selectedId) - Number(b.id === input.selectedId));

    for (const robot of ordered) {
      const st = this.robotState.get(robot.id);
      // hidden when it is in another aisle (unless it is mid-animation out of this one)
      if (!st || st.hidden || (!this.slotInView(robot.nodeId) && !st.anim)) continue;
      const li = levelOf(this.levels, st.y);
      const sink = li >= 0 ? sinkAt(this.levels, st.x, li) : 0;
      const active = robot.id === input.selectedId;
      const lvShelf = li >= 0 ? this.levels[li].shelfY : st.y + RH;
      this.drawRobot(layer, st.x, st.y + sink, robot, {
        active,
        selected: active,
        labelLayer: labels,
        labelY: active ? Math.round(st.y) + 44 : lvShelf + 27,
      });
    }
  }
}
