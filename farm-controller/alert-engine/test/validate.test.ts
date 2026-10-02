import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isElevatorTelemetry, isRobotTelemetry, isShelfSensorData } from "../src/validate.js";

describe("telemetry validation", () => {
  it("accepts contract-compliant robot telemetry", () => {
    assert.equal(isRobotTelemetry({
      robot_id: "robot-1",
      status: "idle",
      current_node: "dock-1",
      task_id: null,
      last_completed_task_id: null,
      battery_pct: 85,
      heading: 1,
      temperature_c: 22,
      timestamp: 1,
    }), true);
  });

  it("rejects incomplete robot telemetry", () => {
    assert.equal(isRobotTelemetry({ robot_id: "robot-1", battery_pct: 85, timestamp: 1 }), false);
  });

  it("validates shelf and elevator payloads", () => {
    assert.equal(isShelfSensorData({
      shelf_id: "shelf-1",
      level: 1,
      temperature_c: 22,
      humidity_pct: 60,
      light_lux: 800,
      soil_moisture_pct: 50,
      ph: 6.5,
      timestamp: 1,
    }), true);
    assert.equal(isElevatorTelemetry({
      elevator_id: "elevator-1",
      current_level: 1,
      status: "moving",
      target_level: 2,
      load_detected: true,
      timestamp: 1,
    }), true);
    assert.equal(isElevatorTelemetry({
      elevator_id: "elevator-1",
      current_level: 1,
      status: "flying",
      target_level: 2,
      load_detected: true,
      timestamp: 1,
    }), false);
  });
});
