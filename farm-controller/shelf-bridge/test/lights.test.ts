import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { LevelLights } from "../src/lights.js";

// The repo's farm: dock and level 0, elevator stops elev-1-L0/L1/L2, levels 1 and 2
const topology = JSON.parse(readFileSync(new URL("../../topology.json", import.meta.url), "utf-8"));
const TIMEOUT = 10_000;

function lightsAt(levels = [0, 1]) {
  const l = new LevelLights({ shelf_id: "shelf-1", levels, robot_timeout_ms: TIMEOUT });
  assert.ok(l.setTopology(topology));
  return l;
}

const at = (node: string | null, status = "en_route") => ({ current_node: node, status });
const lit = (l: LevelLights, now = 0) => [...(l.litLevels(now) ?? [])].sort();

describe("level lights", () => {
  it("lights nothing, and sends nothing, before the topology", () => {
    const l = new LevelLights({ shelf_id: "shelf-1", levels: [0, 1], robot_timeout_ms: TIMEOUT });
    l.onTelemetry("robot-1", at("cp-01"), 0);
    assert.equal(l.command(0), null);
    assert.equal(l.setTopology({ nodes: [] }), false);
    assert.equal(l.command(0), null);
  });

  it("lights the level of the robot's last tag", () => {
    const l = lightsAt();
    assert.deepEqual(l.command(0), { line: "lights 00", on: [] });
    l.onTelemetry("robot-1", at("cp-01"), 0);
    assert.deepEqual(l.command(0), { line: "lights 10", on: [0] });
    l.onTelemetry("robot-1", at("cp-12", "working"), 1);
    assert.deepEqual(l.command(1), { line: "lights 01", on: [1] });
  });

  it("doesn't count a robot on the dock or before its first tag", () => {
    const l = lightsAt();
    l.onTelemetry("robot-1", at("dock-1", "charging"), 0);
    l.onTelemetry("robot-2", at(null, "initializing"), 0);
    assert.deepEqual(lit(l), []);
  });

  it("lights the level it rides to, from the elevator tag it rides from", () => {
    const l = lightsAt();
    l.onState("robot-1", { task: { target_node: "water-11" } });
    l.onTelemetry("robot-1", at("cp-02"), 0);
    assert.deepEqual(lit(l), [0]);
    l.onTelemetry("robot-1", at("elev-1-L0"), 1);
    assert.deepEqual(lit(l, 1), [0, 1]);
    // Off the elevator on level 1: level 0 goes off
    l.onTelemetry("robot-1", at("elev-1-L1"), 2);
    assert.deepEqual(lit(l, 2), [1]);
  });

  it("lights only the last level of a ride through several", () => {
    const l = lightsAt([0, 1, 2]);
    l.onTelemetry("robot-1", at("elev-1-L0"), 0);
    l.onState("robot-1", { task: { target_node: "cp-22" } });
    assert.deepEqual(lit(l), [0, 2]);
  });

  it("rides down to the dock when returning", () => {
    const l = lightsAt();
    l.onTelemetry("robot-1", at("elev-1-L1", "returning_to_dock"), 0);
    assert.deepEqual(lit(l), [0, 1]);
  });

  it("doesn't look ahead when stopped, or with a target on the same level", () => {
    const l = lightsAt();
    l.onState("robot-1", { task: { target_node: "water-11" } });
    l.onTelemetry("robot-1", at("elev-1-L0", "stopped"), 0);
    assert.deepEqual(lit(l), [0]);
    l.onState("robot-1", { task: { target_node: "water-01" } });
    l.onTelemetry("robot-1", at("elev-1-L0"), 0);
    assert.deepEqual(lit(l), [0]);
    l.onState("robot-1", { task: null });
    assert.deepEqual(lit(l), [0]);
  });

  it("keeps a level lit while any robot is on it", () => {
    const l = lightsAt();
    l.onTelemetry("robot-1", at("cp-01"), 0);
    l.onTelemetry("robot-2", at("cp-11"), 0);
    assert.deepEqual(lit(l), [0, 1]);
    l.onTelemetry("robot-2", at("dock-1", "docking"), 1);
    assert.deepEqual(lit(l, 1), [0]);
  });

  it("forgets a silent robot", () => {
    const l = lightsAt();
    l.onTelemetry("robot-1", at("cp-01"), 0);
    assert.deepEqual(lit(l, TIMEOUT), [0]);
    assert.deepEqual(lit(l, TIMEOUT + 1), []);
  });

  it("ignores invalid telemetry, unknown nodes and levels without a relay", () => {
    const l = lightsAt();
    assert.equal(l.onTelemetry("robot-1", { status: "en_route" }, 0), false);
    assert.equal(l.onTelemetry("robot-1", null, 0), false);
    l.onTelemetry("robot-1", at("cp-99"), 0);
    assert.deepEqual(lit(l), []);
    l.onTelemetry("robot-1", at("cp-21"), 0);
    assert.deepEqual(l.command(0), { line: "lights 00", on: [] });
  });

  it("uses a target that arrived before the robot's telemetry", () => {
    const l = lightsAt();
    l.onState("robot-1", { task: { target_node: "water-11" } });
    l.onTelemetry("robot-1", at("elev-1-L0"), 0);
    assert.deepEqual(lit(l), [0, 1]);
  });
});
