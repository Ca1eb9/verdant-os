// ============================================================
// Level lights
//
// Which levels' lights should be on, from where the robots
// report they are. A robot lights the level of the last tag it
// read; riding the elevator, it also lights the level it's
// riding to, so that level is lit when it drives off. A robot
// parked on the dock, or silent, lights nothing.
//
// The robot doesn't report its path, so the ride's end comes
// from the same shortest path the robot computes on board
// (navigation.ts), to the target the orchestrator assigned.
// ============================================================

import {
  type FarmTopology,
  type GraphEdge,
  type GraphNode,
  type NavGraph,
  RobotStatus,
  buildGraph,
  dijkstra,
} from "@farm/shared";
import type { LevelLightsConfig } from "./config.js";

interface RobotSeen {
  node: string | null;
  status: string;
  /** Monotonic ms of its last telemetry */
  at: number;
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

export class LevelLights {
  private graph: NavGraph | null = null;
  private docks: string[] = [];
  private robots = new Map<string, RobotSeen>();
  /** Targets that arrived before the robot's first telemetry */
  private targets = new Map<string, string | null>();

  constructor(private config: LevelLightsConfig) {}

  /** The orchestrator's retained topology. False if it isn't a usable one. */
  setTopology(raw: unknown): boolean {
    if (!isObj(raw) || !Array.isArray(raw.nodes) || !Array.isArray(raw.edges) ||
        raw.nodes.length === 0 || !raw.nodes.every(isNode) || !raw.edges.every(isEdge)) {
      return false;
    }
    this.graph = buildGraph(raw as unknown as FarmTopology);
    this.docks = (raw.nodes as GraphNode[]).filter((n) => n.type === "dock").map((n) => n.id);
    return true;
  }

  get hasTopology(): boolean {
    return this.graph !== null;
  }

  /** A robot's telemetry. False if it isn't valid telemetry. */
  onTelemetry(robotId: string, raw: unknown, now: number): boolean {
    if (!isObj(raw) || !isStr(raw.status) || !(raw.current_node === null || isStr(raw.current_node))) {
      return false;
    }
    this.robots.set(robotId, {
      node: raw.current_node,
      status: raw.status,
      at: now,
      target: this.robots.get(robotId)?.target ?? this.targets.get(robotId) ?? null,
    });
    return true;
  }

  /** The orchestrator's retained state for a robot: only its task's target is used */
  onState(robotId: string, raw: unknown) {
    if (!isObj(raw)) return;
    const target = isObj(raw.task) && isStr(raw.task.target_node) ? raw.task.target_node : null;
    this.targets.set(robotId, target);
    const robot = this.robots.get(robotId);
    if (robot) robot.target = target;
  }

  /** The levels to light; null until the topology is known */
  litLevels(now: number): Set<number> | null {
    const graph = this.graph;
    if (!graph) return null;
    const lit = new Set<number>();
    for (const robot of this.robots.values()) {
      if (now - robot.at > this.config.robot_timeout_ms || robot.node === null) continue;
      const node = graph.nodes.get(robot.node);
      // Unknown to this topology, or parked on the dock: not on a level
      if (!node || node.type === "dock") continue;
      lit.add(node.z);
      const rideEnd = this.rideEnd(graph, node, robot);
      if (rideEnd) lit.add(rideEnd.z);
    }
    return lit;
  }

  /**
   * The line for the node, "lights " and one 1 (on) or 0 per channel, and the
   * configured levels it turns on. Null until the topology is known.
   */
  command(now: number): { line: string; on: number[] } | null {
    const lit = this.litLevels(now);
    if (!lit) return null;
    const on = this.config.levels.filter((level) => lit.has(level));
    return { line: `lights ${this.config.levels.map((level) => (lit.has(level) ? "1" : "0")).join("")}`, on };
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
    } else if (robot.status === RobotStatus.RETURNING_TO_DOCK) {
      // The nearest dock; the robot has one, but the topology may list more
      for (const dock of this.docks) {
        const r = dijkstra(graph, node.id, dock);
        if (r && (!route || r.length < route.length)) route = r;
      }
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
