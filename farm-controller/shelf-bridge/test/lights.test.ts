import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { GrowLights, isLightSwitch } from "../src/lights.js";

// The repo's farm: dock and level 0, elevator stops elev-1-L0/L1/L2, levels 1 and 2
const topology = JSON.parse(readFileSync(new URL("../../topology.json", import.meta.url), "utf-8"));

function growLights(levels = [0], follow_robots?: boolean) {
  const l = new GrowLights({ shelf_id: "shelf-1", levels, follow_robots });
  assert.ok(l.setTopology(topology));
  return l;
}

const at = (node: string | null, status = "en_route") => ({ current_node: node, status });
const task = (target: string) => ({ task: { target_node: target } });

describe("grow lights, off while docked (follow_robots off)", () => {
  it("are on with no robot heard from, and before the topology", () => {
    assert.equal(growLights().line(), "lights 1");
    const l = new GrowLights({ shelf_id: "shelf-1", levels: [0] });
    l.onTelemetry("robot-1", at("dock-1", "charging"));
    assert.equal(l.line(), "lights 1");
    assert.equal(l.setTopology({ nodes: [] }), false);
    assert.equal(l.setTopology({ nodes: topology.nodes }), false);
    // the topology arriving later puts it right
    assert.ok(l.setTopology(topology));
    assert.equal(l.line(), "lights 0");
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

  it("light every level, whatever level the robot is on", () => {
    const l = growLights([0, 1]);
    l.onTelemetry("robot-1", at("cp-12", "working"));
    assert.equal(l.line(), "lights 11");
    l.onTelemetry("robot-1", at("cp-21", "working"));
    assert.equal(l.line(), "lights 11");
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

  it("ignore the orchestrator's targets", () => {
    const l = growLights([0, 1]);
    l.onState("robot-1", task("cp-21"));
    l.onTelemetry("robot-1", at("elev-1-L0"));
    assert.equal(l.line(), "lights 11");
  });
});

describe("grow lights, per level (follow_robots on)", () => {
  it("light the level of the robot's last tag only", () => {
    const l = growLights([0, 1], true);
    l.onTelemetry("robot-1", at("cp-01"));
    assert.equal(l.line(), "lights 10");
    l.onTelemetry("robot-1", at("cp-12", "working"));
    assert.equal(l.line(), "lights 01");
    // a level with no relay is lit for nobody
    l.onTelemetry("robot-1", at("cp-21", "working"));
    assert.equal(l.line(), "lights 00");
  });

  it("light nothing while every robot is docked, and the dock's level as one drives off", () => {
    const l = growLights([0, 1], true);
    l.onTelemetry("robot-1", at("dock-1", "charging"));
    assert.equal(l.line(), "lights 00");
    assert.equal(l.state(1).robots_docked, true);
    l.onTelemetry("robot-1", at("dock-1", "en_route"));
    assert.equal(l.line(), "lights 10");
  });

  it("light every robot's level", () => {
    const l = growLights([0, 1], true);
    l.onTelemetry("robot-1", at("cp-01"));
    l.onTelemetry("robot-2", at("cp-12", "working"));
    l.onTelemetry("robot-3", at("dock-1", "charging"));
    assert.equal(l.line(), "lights 11");
  });

  it("light the level an elevator ride goes to, from the elevator tag it rides from", () => {
    const l = growLights([0, 1], true);
    l.onState("robot-1", task("water-11"));
    l.onTelemetry("robot-1", at("elev-1-L0"));
    assert.equal(l.line(), "lights 11");
    // off the elevator on level 1: level 0 goes off
    l.onTelemetry("robot-1", at("cp-11"));
    assert.equal(l.line(), "lights 01");
  });

  it("light only the end of a ride through several levels", () => {
    const l = growLights([0, 1], true);
    l.onState("robot-1", task("cp-22"));
    l.onTelemetry("robot-1", at("elev-1-L0"));
    // level 2's end isn't one of the relays' levels; level 1 is passed
    assert.equal(l.line(), "lights 10");
  });

  it("look ahead to the dock's level when returning", () => {
    const l = growLights([0, 1], true);
    l.onTelemetry("robot-1", at("elev-1-L1", "returning_to_dock"));
    assert.equal(l.line(), "lights 11");
  });

  it("take a target that arrived before the robot's telemetry", () => {
    const l = growLights([0, 1], true);
    l.onState("robot-1", task("water-11"));
    l.onTelemetry("robot-1", at("elev-1-L0"));
    assert.equal(l.line(), "lights 11");
  });

  it("don't look ahead without a target, or while stopped", () => {
    const l = growLights([0, 1], true);
    l.onTelemetry("robot-1", at("elev-1-L0"));
    assert.equal(l.line(), "lights 10");
    l.onState("robot-1", task("water-11"));
    l.onTelemetry("robot-1", at("elev-1-L0", "stopped"));
    assert.equal(l.line(), "lights 10");
  });

  it("light every level when it can't tell where a robot is", () => {
    const l = growLights([0, 1], true);
    l.onTelemetry("robot-1", at("cp-12", "working"));
    l.onTelemetry("robot-2", at(null, "initializing"));
    assert.equal(l.line(), "lights 11");
    l.onTelemetry("robot-2", at("not-a-node"));
    assert.equal(l.line(), "lights 11");
  });

  it("light every level with no robot heard from, and before the topology", () => {
    assert.equal(growLights([0, 1], true).line(), "lights 11");
    const l = new GrowLights({ shelf_id: "shelf-1", levels: [0, 1], follow_robots: true });
    l.onTelemetry("robot-1", at("cp-12", "working"));
    assert.equal(l.line(), "lights 11");
    assert.ok(l.setTopology(topology));
    assert.equal(l.line(), "lights 01");
  });

  it("keep a robot that goes silent lighting its level", () => {
    const l = growLights([0, 1], true);
    l.onTelemetry("robot-1", at("cp-12", "working"));
    assert.equal(l.line(), "lights 01");
  });

  it("let the operator's switch keep a level off, and say why the others are off", () => {
    const l = growLights([0, 1], true);
    l.onTelemetry("robot-1", at("cp-01"));
    assert.ok(l.setOperator(0, false));
    assert.equal(l.line(), "lights 00");
    assert.deepEqual(l.state(3), {
      lights: [{ level: 0, operator_on: false, on: false }, { level: 1, operator_on: true, on: false }],
      robots_docked: false,
      timestamp: 3,
    });
    assert.ok(l.setOperator(0, true));
    assert.equal(l.line(), "lights 10");
  });
});

describe("the operator's switch", () => {
  it("keeps a level off whatever the robots do, until switched on", () => {
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

  it("is refused for a level no relay switches", () => {
    const l = growLights();
    assert.equal(l.setOperator(1, false), false);
    assert.equal(l.setOperator(0.5, false), false);
    assert.equal(l.line(), "lights 1");
  });
});

describe("input", () => {
  it("refuses invalid telemetry", () => {
    const l = growLights();
    assert.equal(l.onTelemetry("robot-1", { current_node: 5, status: "idle" }), false);
    assert.equal(l.onTelemetry("robot-1", null), false);
  });

  it("ignores a robot state that isn't one", () => {
    const l = growLights([0, 1], true);
    l.onState("robot-1", null);
    l.onState("robot-1", { task: "water" });
    l.onTelemetry("robot-1", at("elev-1-L0"));
    assert.equal(l.line(), "lights 10");
  });

  it("takes a light switch from the dashboard, and refuses malformed ones", () => {
    const ok = { level: 0, on: false, issued_by: "dashboard", timestamp: 1 };
    assert.equal(isLightSwitch(ok), true);
    assert.equal(isLightSwitch({ ...ok, on: "false" }), false);
    assert.equal(isLightSwitch({ ...ok, level: "0" }), false);
    assert.equal(isLightSwitch({ ...ok, issued_by: "" }), false);
    assert.equal(isLightSwitch({ ...ok, timestamp: null }), false);
  });
});
