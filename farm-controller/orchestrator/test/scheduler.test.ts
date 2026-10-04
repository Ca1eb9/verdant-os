import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  type FarmTask,
  type FarmTopology,
  type OrchestratorConfig,
  CommandSource,
  PlantType,
  TaskPriority,
  TaskStatus,
  buildGraph,
} from "@farm/shared";
import { loadConfig } from "../src/config.js";
import { nextTask, validatePlants, type PlantPlan } from "../src/scheduler.js";

const topology: FarmTopology = JSON.parse(
  readFileSync(new URL("../../topology.json", import.meta.url), "utf-8"),
);
const graph = buildGraph(topology);

const HOUR = 3_600_000;
const MIN = 60_000;
const RETRY = MIN;
const BASIL = {
  plant_type: PlantType.BASIL,
  light_duration_ms: 16 * HOUR,
  light_interval_ms: 24 * HOUR,
  water_duration_ms: 15 * MIN,
  water_interval_ms: 4 * HOUR,
};
const ENTRY = { robot_id: "robot-1", plant_type: "basil", water_node: "water-01", grow_node: "cp-02" };

function config(robotPlants: unknown[], schedules: unknown[] = [BASIL]): OrchestratorConfig {
  return { ...loadConfig(), plant_schedules: schedules, robot_plants: robotPlants } as OrchestratorConfig;
}

const plan: PlantPlan = validatePlants(config([ENTRY]), graph)[0];
const NOW = 100 * 24 * HOUR;

function done(
  type: FarmTask["type"],
  completedAgo: number,
  extra: Partial<FarmTask> = {},
): FarmTask {
  return {
    task_id: `t-${Math.random()}`,
    type,
    duration_ms: type === "water" ? BASIL.water_duration_ms : HOUR,
    priority: TaskPriority.NORMAL,
    source: CommandSource.SCHEDULER,
    created_at: NOW - completedAgo - HOUR,
    status: TaskStatus.COMPLETED,
    pinned_robot: "robot-1",
    assigned_robot: "robot-1",
    completed_at: NOW - completedAgo,
    ...extra,
  };
}

describe("validatePlants", () => {
  it("accepts the checked-in config", () => {
    const path = fileURLToPath(new URL("../../orchestrator-config.json", import.meta.url));
    const plans = validatePlants(loadConfig(path), graph);
    assert.equal(plans.length, 1);
    assert.equal(plans[0].schedule.plant_type, "basil");
  });

  it("skips every kind of bad entry", () => {
    const bad = [
      { ...ENTRY, robot_id: "" },
      { ...ENTRY, plant_type: "cactus" },
      { ...ENTRY, plant_type: "lettuce" },          // no schedule
      { ...ENTRY, water_node: "cp-01" },            // not a water node
      { ...ENTRY, water_node: "nowhere" },
      { ...ENTRY, grow_node: "elev-1-L0" },
      { ...ENTRY, grow_node: "dock-1" },
      { ...ENTRY, grow_node: "nowhere" },
      null,
      "robot-1",
    ];
    assert.deepEqual(validatePlants(config(bad), graph), []);
    assert.equal(validatePlants(config([ENTRY, ENTRY]), graph).length, 1);
    assert.deepEqual(validatePlants(config([ENTRY], [{ ...BASIL, light_duration_ms: 25 * HOUR }]), graph), []);
    assert.deepEqual(validatePlants(config([ENTRY], [{ ...BASIL, water_interval_ms: -1 }]), graph), []);
    assert.deepEqual(validatePlants(config([ENTRY], [{ ...BASIL, water_duration_ms: 4 * HOUR }]), graph), []);
    assert.deepEqual(validatePlants({ ...config([]), robot_plants: "x" } as never, graph), []);
  });

  it("turns the scheduler off for a bad interval", () => {
    for (const bad of [0, -1, NaN, "60000", undefined]) {
      assert.deepEqual(validatePlants({ ...config([ENTRY]), scheduler_interval_ms: bad } as never, graph), []);
      assert.deepEqual(validatePlants({ ...config([ENTRY]), task_retry_delay_ms: bad } as never, graph), []);
    }
  });
});

describe("nextTask", () => {
  it("waters a plant with no history", () => {
    const t = nextTask(plan, [], [], NOW, RETRY)!;
    assert.equal(t.type, "water");
    assert.equal(t.target_node, "water-01");
    assert.equal(t.duration_ms, BASIL.water_duration_ms);
    assert.equal(t.priority, TaskPriority.NORMAL);
    assert.equal(t.source, CommandSource.SCHEDULER);
    assert.equal(t.pinned_robot, "robot-1");
    assert.equal(t.status, TaskStatus.PENDING);
    assert.equal(t.created_at, NOW);
  });

  it("waters again exactly when the interval is up", () => {
    assert.equal(nextTask(plan, [], [done("water", 4 * HOUR - 1)], NOW, RETRY)?.type, "grow");
    assert.equal(nextTask(plan, [], [done("water", 4 * HOUR)], NOW, RETRY)?.type, "water");
  });

  it("grows until the next watering, at low priority", () => {
    const t = nextTask(plan, [], [done("water", HOUR)], NOW, RETRY)!;
    assert.equal(t.type, "grow");
    assert.equal(t.target_node, "cp-02");
    assert.equal(t.duration_ms, 3 * HOUR);
    assert.equal(t.priority, TaskPriority.LOW);
  });

  it("grows only the light still owed over the last light_interval_ms", () => {
    const lit = [done("water", HOUR), done("grow", 2 * HOUR, { duration_ms: 15.5 * HOUR })];
    assert.equal(nextTask(plan, [], lit, NOW, RETRY)?.duration_ms, 30 * MIN);
    // Light older than the window doesn't count
    const old = [done("water", HOUR), done("grow", 24 * HOUR, { duration_ms: 15.5 * HOUR })];
    assert.equal(nextTask(plan, [], old, NOW, RETRY)?.duration_ms, 3 * HOUR);
    const full = [done("water", HOUR), done("grow", 2 * HOUR, { duration_ms: 16 * HOUR })];
    assert.equal(nextTask(plan, [], full, NOW, RETRY), null);
  });

  it("only counts completed care on this robot, from any source", () => {
    const remote = done("water", HOUR, { source: CommandSource.REMOTE, pinned_robot: undefined });
    assert.equal(nextTask(plan, [], [remote], NOW, RETRY)?.type, "grow");
    const other = done("water", HOUR, { assigned_robot: "robot-2", pinned_robot: "robot-2" });
    assert.equal(nextTask(plan, [], [other], NOW, RETRY)?.type, "water");
    const failed = done("water", HOUR, { status: TaskStatus.FAILED, created_at: NOW - 2 * HOUR });
    assert.equal(nextTask(plan, [], [failed], NOW, RETRY)?.type, "water");
  });

  it("keeps one scheduler task per robot outstanding", () => {
    const mine = { ...done("grow", 0), status: TaskStatus.PENDING, completed_at: undefined };
    assert.equal(nextTask(plan, [mine], [], NOW, RETRY), null);
    const theirs = { ...mine, pinned_robot: "robot-2" };
    const operator = { ...mine, source: CommandSource.REMOTE };
    assert.equal(nextTask(plan, [theirs, operator], [], NOW, RETRY)?.type, "water");
  });

  it("waits task_retry_delay_ms after a failure, from when it failed", () => {
    // Created long ago (it sat in the queue): the wait still runs from the failure
    const recent = done("water", RETRY - 1, { status: TaskStatus.FAILED, created_at: NOW - 5 * HOUR });
    assert.equal(nextTask(plan, [], [recent], NOW, RETRY), null);
    const older = done("water", RETRY, { status: TaskStatus.FAILED });
    assert.equal(nextTask(plan, [], [older], NOW, RETRY)?.type, "water");
    // Only the latest one matters
    const failedThenDone = [
      done("water", 2 * HOUR, { status: TaskStatus.FAILED }),
      done("water", 30_000),
    ];
    assert.equal(nextTask(plan, [], failedThenDone, NOW, RETRY)?.type, "grow");
  });

  it("treats a cancelled scheduler task as that care for one interval", () => {
    const water = done("water", HOUR, { status: TaskStatus.CANCELLED, assigned_robot: undefined });
    const t = nextTask(plan, [], [water], NOW, RETRY)!;
    assert.equal(t.type, "grow");        // no wait after a cancel
    assert.equal(t.duration_ms, 3 * HOUR);
    const grow = done("grow", 0, { status: TaskStatus.CANCELLED, duration_ms: 16 * HOUR });
    assert.equal(nextTask(plan, [], [done("water", HOUR), grow], NOW, RETRY), null);
    // An operator's cancelled task isn't scheduled care
    const operator = done("water", HOUR, { status: TaskStatus.CANCELLED, source: CommandSource.REMOTE });
    assert.equal(nextTask(plan, [], [operator], NOW, RETRY)?.type, "water");
  });

  it("ignores anything stamped after now (clock started behind)", () => {
    // The last watering looks an hour in the future: water anyway
    const ahead = done("water", -HOUR);
    assert.equal(nextTask(plan, [], [ahead], NOW, RETRY)?.type, "water");
    // and once watered now, light runs to 4 h after this watering, not after
    // the stamp ahead (which counts normally once the clock passes it)
    const after = [ahead, done("water", 0)];
    assert.equal(nextTask(plan, [], after, NOW + 30 * MIN, RETRY)?.duration_ms, 3.5 * HOUR);
    // A failure in the future doesn't hold retries back
    const failed = done("water", -HOUR, { status: TaskStatus.FAILED });
    assert.equal(nextTask(plan, [], [failed], NOW, RETRY)?.type, "water");
    // Nor does light in the future count
    const lit = [done("water", HOUR), done("grow", -HOUR, { duration_ms: 16 * HOUR })];
    assert.equal(nextTask(plan, [], lit, NOW, RETRY)?.duration_ms, 3 * HOUR);
  });
});
