// ============================================================
// Plant scheduler — water and light tasks for each robot's plant
//
// Keeps no state of its own. When a plant was last watered and how
// much light it has had come from the finished tasks the orchestrator
// already persists, so a restart can't water twice. Every tick, for
// each plant in robot_plants:
//   1. at most one scheduler task per robot, queued or assigned
//   2. after one failed, wait task_retry_delay_ms
//   3. water when water_interval_ms has passed since the last watering
//   4. otherwise grow while the light over the last light_interval_ms is
//      short, ending by the next watering
// Care counts when it completes on the robot (from any source), or when
// an operator cancels one of these tasks: a cancel skips that care for
// one interval. Water (normal) outranks grow (low); charging beats both.
// ============================================================

import { randomUUID } from "crypto";
import {
  type FarmTask,
  type NavGraph,
  type OrchestratorConfig,
  type PlantSchedule,
  type RobotPlant,
  CommandSource,
  PlantType,
  TaskPriority,
  TaskStatus,
  dijkstra,
} from "@farm/shared";

export interface PlantPlan extends RobotPlant {
  schedule: PlantSchedule;
}

function isPositive(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/** Plans for the valid robot_plants entries; logs and skips the rest */
export function validatePlants(config: OrchestratorConfig, graph: NavGraph): PlantPlan[] {
  // A bad interval would run the scheduler every millisecond: refuse it all.
  if (!isPositive(config.scheduler_interval_ms) || !isPositive(config.task_retry_delay_ms)) {
    console.error("[SCHED] scheduler_interval_ms and task_retry_delay_ms must be positive " +
      "numbers: plant scheduler off");
    return [];
  }
  const plans: PlantPlan[] = [];
  for (const raw of Array.isArray(config.robot_plants) ? config.robot_plants : []) {
    const plan = planFor(raw, config, graph);
    if (typeof plan === "string") {
      console.warn(`[SCHED] Skipping robot_plants entry ${JSON.stringify(raw)}: ${plan}`);
    } else if (plans.some((q) => q.robot_id === plan.robot_id)) {
      console.warn(`[SCHED] Skipping robot_plants entry ${JSON.stringify(raw)}: robot listed twice`);
    } else {
      plans.push(plan);
    }
  }
  return plans;
}

/** The plan for one entry, or what's wrong with it */
function planFor(raw: unknown, config: OrchestratorConfig, graph: NavGraph): PlantPlan | string {
  const p = (raw ?? {}) as Partial<RobotPlant>;
  if (typeof p.robot_id !== "string" || !p.robot_id) return "no robot_id";
  if (!Object.values(PlantType).includes(p.plant_type as PlantType)) return "unknown plant_type";
  const schedules = Array.isArray(config.plant_schedules) ? config.plant_schedules : [];
  const s = schedules.find((x) => x?.plant_type === p.plant_type);
  if (!s) return `no schedule for ${p.plant_type}`;
  const times = [s.water_interval_ms, s.water_duration_ms, s.light_interval_ms, s.light_duration_ms];
  if (!times.every(isPositive)) return `bad schedule for ${p.plant_type}`;
  if (s.light_duration_ms > s.light_interval_ms) return "light_duration_ms > light_interval_ms";
  if (s.water_duration_ms >= s.water_interval_ms) return "water_duration_ms >= water_interval_ms";

  const water = graph.nodes.get(p.water_node ?? "");
  const grow = graph.nodes.get(p.grow_node ?? "");
  if (water?.type !== "water") return "water_node isn't a water node";
  if (!grow || grow.type === "elevator" || grow.type === "dock") {
    return "grow_node must exist and not be an elevator or the dock";
  }
  const dock = [...graph.nodes.values()].find((n) => n.type === "dock");
  if (dock && (!dijkstra(graph, dock.id, water.id) || !dijkstra(graph, dock.id, grow.id))) {
    return "water_node or grow_node can't be reached from the dock";
  }
  return { ...(p as RobotPlant), schedule: s };
}

/**
 * The task this plant needs now, or null.
 * `outstanding`: queued and assigned tasks. `finished`: completed, failed and cancelled.
 */
export function nextTask(
  plan: PlantPlan,
  outstanding: readonly FarmTask[],
  finished: readonly FarmTask[],
  now: number,
  retryDelayMs: number,
): FarmTask | null {
  const s = plan.schedule;
  const ours = (t: FarmTask) =>
    t.source === CommandSource.SCHEDULER && t.pinned_robot === plan.robot_id;
  if (outstanding.some(ours)) return null;

  // Ignore anything stamped after now: the Pi has no clock battery, so it
  // can start behind after a power cut. At worst that waters once extra.
  const past = finished.filter((t) =>
    typeof t.completed_at === "number" && t.completed_at <= now);

  const latest = past.filter(ours).reduce<FarmTask | null>(
    (a, t) => (!a || t.completed_at! > a.completed_at! ? t : a), null);
  if (latest?.status === TaskStatus.FAILED && now - latest.completed_at! < retryDelayMs) {
    return null;
  }

  const care = past.filter((t) =>
    (t.status === TaskStatus.COMPLETED && t.assigned_robot === plan.robot_id) ||
    (t.status === TaskStatus.CANCELLED && ours(t)));
  const lastWater = Math.max(-Infinity, ...care.filter((t) => t.type === "water")
    .map((t) => t.completed_at!));
  const waterDue = lastWater + s.water_interval_ms;
  if (now >= waterDue) {
    return task(plan, "water", plan.water_node, s.water_duration_ms, TaskPriority.NORMAL, now);
  }

  const lit = care
    .filter((t) => t.type === "grow" && t.completed_at! > now - s.light_interval_ms)
    .reduce((sum, t) => sum + (t.duration_ms ?? 0), 0);
  const duration = Math.min(s.light_duration_ms - lit, waterDue - now);
  if (duration <= 0) return null;
  return task(plan, "grow", plan.grow_node, duration, TaskPriority.LOW, now);
}

function task(
  plan: PlantPlan,
  type: "water" | "grow",
  node: string,
  duration: number,
  priority: TaskPriority,
  now: number,
): FarmTask {
  return {
    task_id: randomUUID(),
    type,
    target_node: node,
    duration_ms: duration,
    priority,
    source: CommandSource.SCHEDULER,
    created_at: now,
    status: TaskStatus.PENDING,
    pinned_robot: plan.robot_id,
  };
}
