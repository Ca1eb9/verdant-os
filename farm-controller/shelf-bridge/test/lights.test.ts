import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { GrowLights, isLightSwitch } from "../src/lights.js";

// The repo's farm, with its dock at dock-1
const topology = JSON.parse(readFileSync(new URL("../../topology.json", import.meta.url), "utf-8"));

function growLights(levels = [0]) {
  const l = new GrowLights({ shelf_id: "shelf-1", levels });
  assert.ok(l.setTopology(topology));
  return l;
}

const at = (node: string | null, status = "en_route") => ({ current_node: node, status });

describe("grow lights", () => {
  it("are on with no robot heard from, and before the topology", () => {
    assert.equal(growLights().line(), "lights 1");
    const l = new GrowLights({ shelf_id: "shelf-1", levels: [0] });
    l.onTelemetry("robot-1", at("dock-1", "charging"));
    assert.equal(l.line(), "lights 1");
    assert.equal(l.setTopology({ nodes: [] }), false);
  });

  it("go off when the robot reaches the dock, and on as it drives off", () => {
    const l = growLights();
    l.onTelemetry("robot-1", at("cp-01"));
    assert.equal(l.line(), "lights 1");
    l.onTelemetry("robot-1", at("dock-1", "docking"));
    assert.equal(l.line(), "lights 0");
    assert.equal(l.state(5).robots_docked, true);
    l.onTelemetry("robot-1", at("dock-1", "charging"));
    assert.equal(l.line(), "lights 0");
    // its last tag is still the dock until the next one
    l.onTelemetry("robot-1", at("dock-1", "en_route"));
    assert.equal(l.line(), "lights 1");
  });

  it("stay on while any robot is off the dock", () => {
    const l = growLights();
    l.onTelemetry("robot-1", at("dock-1", "charging"));
    l.onTelemetry("robot-2", at("cp-12", "working"));
    assert.equal(l.line(), "lights 1");
    l.onTelemetry("robot-2", at("dock-1", "idle"));
    assert.equal(l.line(), "lights 0");
  });

  it("keep a robot that goes silent where it last was", () => {
    const l = growLights();
    l.onTelemetry("robot-1", at("cp-12", "working"));
    // nothing more from it: only reaching the dock turns them off
    assert.equal(l.line(), "lights 1");
  });

  it("count a robot that hasn't read a tag yet as off the dock", () => {
    const l = growLights();
    l.onTelemetry("robot-1", at(null, "initializing"));
    assert.equal(l.line(), "lights 1");
  });

  it("follow the operator's switch per level, docked or not", () => {
    const l = growLights([0, 1]);
    l.onTelemetry("robot-1", at("cp-01"));
    assert.ok(l.setOperator(1, false));
    assert.equal(l.line(), "lights 10");
    assert.deepEqual(l.state(7), {
      lights: [{ level: 0, operator_on: true, on: true }, { level: 1, operator_on: false, on: false }],
      robots_docked: false,
      timestamp: 7,
    });
    l.onTelemetry("robot-1", at("dock-1", "charging"));
    assert.equal(l.line(), "lights 00");
    l.onTelemetry("robot-1", at("cp-01"));
    assert.ok(l.setOperator(1, true));
    assert.equal(l.line(), "lights 11");
  });

  it("refuse a switch for a level no relay switches", () => {
    const l = growLights();
    assert.equal(l.setOperator(1, false), false);
    assert.equal(l.setOperator(0.5, false), false);
    assert.equal(l.line(), "lights 1");
  });

  it("refuse invalid telemetry", () => {
    const l = growLights();
    assert.equal(l.onTelemetry("robot-1", { current_node: 5, status: "idle" }), false);
    assert.equal(l.onTelemetry("robot-1", null), false);
  });
});

describe("isLightSwitch", () => {
  const ok = { level: 0, on: false, issued_by: "dashboard", timestamp: 1 };
  it("takes a switch from the dashboard", () => assert.equal(isLightSwitch(ok), true));
  it("refuses malformed ones", () => {
    assert.equal(isLightSwitch({ ...ok, on: "false" }), false);
    assert.equal(isLightSwitch({ ...ok, level: "0" }), false);
    assert.equal(isLightSwitch({ ...ok, issued_by: "" }), false);
    assert.equal(isLightSwitch({ ...ok, timestamp: null }), false);
  });
});
