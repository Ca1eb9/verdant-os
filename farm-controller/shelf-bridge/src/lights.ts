// ============================================================
// Grow lights
//
// Which levels' grow lights (one relay channel each on a shelf
// node) should be on. Each is on while the operator has it
// switched on (the dashboard) and:
//   - by default, while any robot is off the dock: a robot
//     reaching the dock turns them off once every robot is there;
//   - with follow_robots, while a robot is on that level, or is
//     about to ride the elevator to it.
// Anything unknown (no robot heard from, no topology yet, a robot
// that hasn't read a tag) leaves the lights on: the plants keep
// their light. A robot that goes silent stays where it last was.
//
// The robot doesn't report its path, so an elevator ride's end
// comes from the same shortest path the robot computes on board
// (navigation.ts), to the target the orchestrator assigned.
// ============================================================

import {
  type FarmTopology,
  type GraphEdge,
  type GraphNode,
  type LightState,
  type LightSwitch,
  type LightsState,
  type NavGraph,
  RobotStatus,
  buildGraph,
  dijkstra,
} from "@farm/shared";
import type { GrowLightsConfig } from "./config.js";

interface RobotSeen {
  node: string | null;
  status: string;
  /** The orchestrator's target for its task, from its retained state */
  target: string | null;
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;

function isNode(v: unknown): v is GraphNode {
  return isObj(v) && isStr(v.id) && Number.isInteger(v.z) && isStr(v.type);
}

function isEdge(v: unknown): v is GraphEdge {
  return isObj(v) && isStr(v.from) && isStr(v.to) &&
    typeof v.cost === "number" && Number.isFinite(v.cost) && v.cost >= 0;
}

/** A light switch from the dashboard; its level is checked against the config by setOperator */
export function isLightSwitch(v: unknown): v is LightSwitch {
  return isObj(v) && Number.isInteger(v.level) && typeof v.on === "boolean" &&
    isStr(v.issued_by) && typeof v.timestamp === "number" && Number.isFinite(v.timestamp);
}

export class GrowLights {
  private graph: NavGraph | null = null;
  /** The first dock, as on the robot (GRAPH_DOCK), the simulator and the scheduler */
  private dock: string | null = null;
  private robots = new Map<string, RobotSeen>();
  /** Targets that arrived before the robot's first telemetry */
  private targets = new Map<string, string | null>();
  /** The operator's switch per configured level, on until switched off (in memory: a restart turns them on) */
  private operatorOn: boolean[];

  constructor(private config: GrowLightsConfig) {
    this.operatorOn = config.levels.map(() => true);
  }

  /** The orchestrator's retained topology. False if it isn't a usable one. */
  setTopology(raw: unknown): boolean {
    if (!isObj(raw) || !Array.isArray(raw.nodes) || !Array.isArray(raw.edges) ||
        raw.nodes.length === 0 || !raw.nodes.every(isNode) || !raw.edges.every(isEdge)) {
      return false;
    }
    this.graph = buildGraph(raw as unknown as FarmTopology);
    this.dock = (raw.nodes as GraphNode[]).find((n) => n.type === "dock")?.id ?? null;
    return true;
  }

  /** A robot's telemetry. False if it isn't valid telemetry. */
  onTelemetry(robotId: string, raw: unknown): boolean {
    if (!isObj(raw) || !isStr(raw.status) || !(raw.current_node === null || isStr(raw.current_node))) {
      return false;
    }
    this.robots.set(robotId, {
      node: raw.current_node,
      status: raw.status,
      target: this.robots.get(robotId)?.target ?? this.targets.get(robotId) ?? null,
    });
    return true;
  }

  /** The orchestrator's retained state for a robot: only its task's target is used (follow_robots) */
  onState(robotId: string, raw: unknown) {
    if (!isObj(raw)) return;
    const target = isObj(raw.task) && isStr(raw.task.target_node) ? raw.task.target_node : null;
    this.targets.set(robotId, target);
    const robot = this.robots.get(robotId);
    if (robot) robot.target = target;
  }

  /** The operator's switch for one level's lights. False if no relay switches that level. */
  setOperator(level: number, on: boolean): boolean {
    const channel = this.config.levels.indexOf(level);
    if (channel < 0) return false;
    this.operatorOn[channel] = on;
    return true;
  }

  /**
   * Every robot heard from is parked on the dock: from its dock tag until it
   * drives off (en_route from the dock counts as leaving). None heard from,
   * or no topology yet to know the dock: not docked, so the lights stay on.
   */
  robotsDocked(): boolean {
    return this.robots.size > 0 && [...this.robots.values()].every((robot) => this.parked(robot));
  }

  /**
   * The levels lit by where the robots are; null for every level (no
   * topology yet, or a robot whose place it can't tell)
   */
  litLevels(): Set<number> | null {
    if (!this.config.follow_robots) return this.robotsDocked() ? new Set() : null;
    const graph = this.graph;
    if (!graph || this.robots.size === 0) return null;
    const lit = new Set<number>();
    for (const robot of this.robots.values()) {
      if (this.parked(robot)) continue;
      const node = robot.node === null ? undefined : graph.nodes.get(robot.node);
      // Not read a tag yet (just booted), or a tag this topology doesn't have:
      // it could be on any level
      if (!node) return null;
      lit.add(node.z);
      const rideEnd = this.rideEnd(graph, node, robot);
      if (rideEnd) lit.add(rideEnd.z);
    }
    return lit;
  }

  /** Each level's switch and whether its lights are lit, for the dashboard */
  state(timestamp: number): LightsState {
    const lit = this.litLevels();
    const lights: LightState[] = this.config.levels.map((level, i) => ({
      level,
      operator_on: this.operatorOn[i],
      on: this.operatorOn[i] && (lit === null || lit.has(level)),
    }));
    return { lights, robots_docked: this.robotsDocked(), timestamp };
  }

  /** The line for the node: "lights " and one 1 (on) or 0 per relay channel */
  line(): string {
    return `lights ${this.state(0).lights.map((l) => (l.on ? "1" : "0")).join("")}`;
  }

  private parked(robot: RobotSeen): boolean {
    if (robot.node === null || robot.status === RobotStatus.EN_ROUTE) return false;
    return this.graph?.nodes.get(robot.node)?.type === "dock";
  }

  /**
   * At an elevator and about to ride it: the elevator node where the ride
   * ends (a ride through several levels is one ride, so the levels passed
   * aren't lit). Null when it isn't riding from here.
   */
  private rideEnd(graph: NavGraph, node: GraphNode, robot: RobotSeen): GraphNode | null {
    if (node.type !== "elevator") return null;
    let route: string[] | null = null;
    if (robot.status === RobotStatus.EN_ROUTE && robot.target) {
      route = dijkstra(graph, node.id, robot.target);
    } else if (robot.status === RobotStatus.RETURNING_TO_DOCK && this.dock) {
      route = dijkstra(graph, node.id, this.dock);
    }
    if (!route) return null;
    let end: GraphNode | null = null;
    for (const id of route.slice(1)) {
      const next = graph.nodes.get(id);
      if (next?.type !== "elevator") break;
      end = next;
    }
    return end && end.z !== node.z ? end : null;
  }
}
