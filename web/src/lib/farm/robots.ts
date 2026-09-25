import type { NavGraph } from "@/lib/farm/navigation";
import { resolveNode } from "@/lib/farm/navigation";
import type { PlantHealth, RobotDraw } from "@/lib/farm/map/renderer";
import type { GraphNode, GrowthStage, Heading, PlantRecord, RobotStatus } from "@/lib/farm/types";

/** Robot state as the dashboard sees it (telemetry + orchestrator extras) */
export interface RobotView {
  id: string;
  status: RobotStatus;
  /** current_node from telemetry: an RFID tag id (or a node id) */
  currentNode: string | null;
  batteryPct: number;
  heading?: Heading;
  /** Unix ms of the last message from this robot */
  lastSeen: number;
  plant?: PlantRecord;
  /** Planned path from the orchestrator (node ids), when it provides one */
  expectedPath?: string[];
  taskLabel?: string;
}

/** Same as orchestrator-config.json heartbeat_timeout_ms */
export const ROBOT_STALE_MS = 30_000;

const GROWTH: Record<GrowthStage, number> = {
  seedling: 0.35,
  vegetative: 0.55,
  mature: 0.75,
  harvest_ready: 0.9,
};

const STATUS_LABEL: Record<RobotStatus, string> = {
  idle: "Idle",
  en_route: "Moving",
  working: "Working",
  returning_to_dock: "Returning",
  docking: "Docking",
  charging: "Charging",
  lost: "Lost",
  error: "Error",
  manual: "Stopped",
};

export function statusLabel(status: RobotStatus) {
  return STATUS_LABEL[status] ?? status;
}

export function isStale(robot: RobotView, now: number) {
  return now - robot.lastSeen > ROBOT_STALE_MS;
}

export function isMoving(status: RobotStatus) {
  return status === "en_route" || status === "returning_to_dock" || status === "docking";
}

/** Badge text on the map: what the robot is doing where it is */
export function actionLabel(robot: RobotView, node: GraphNode | undefined, stale: boolean) {
  if (stale) return "Offline";
  if (robot.status === "working") return node?.type === "water" ? "Watering" : "Growing";
  return statusLabel(robot.status);
}

export function toRobotDraw(robot: RobotView, graph: NavGraph, now: number): RobotDraw {
  const node = resolveNode(graph, robot.currentNode);
  const stale = isStale(robot, now);
  const lost = robot.status === "lost";
  const health: PlantHealth = "good";
  return {
    id: robot.id,
    nodeId: lost ? null : node?.id ?? null,
    action: actionLabel(robot, node, stale),
    battery: robot.batteryPct,
    health,
    growth: robot.plant ? GROWTH[robot.plant.growth_stage] ?? 0.55 : 0.55,
    lit: robot.status === "working" && node?.type === "checkpoint",
  };
}
