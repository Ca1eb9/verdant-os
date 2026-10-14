import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isFarmAlert, isRobotTelemetry, isShelfSensorData } from "../src/validate.js";

const shelf = {
  shelf_id: "shelf-1",
  level: 0,
  temperature_c: 22,
  humidity_pct: 60,
  light_lux: 800,
  water_temp_c: 20,
  water_level_ok: true,
  ph: 6.2,
  timestamp: 1,
};

describe("telemetry validation", () => {
  it("accepts contract-compliant robot telemetry, with or without air readings", () => {
    const robot = {
      robot_id: "robot-1",
      status: "idle",
      current_node: "dock-1",
      task_id: null,
      last_completed_task_id: null,
      battery_pct: 85,
      heading: 1,
      obstacle_cm: null,
      temperature_c: 22,
      humidity_pct: 50,
      timestamp: 1,
    };
    assert.equal(isRobotTelemetry(robot), true);
    assert.equal(isRobotTelemetry({ ...robot, temperature_c: undefined, humidity_pct: undefined }), true);
  });

  it("rejects incomplete robot telemetry", () => {
    assert.equal(isRobotTelemetry({ robot_id: "robot-1", battery_pct: 85, timestamp: 1 }), false);
  });

  it("accepts shelf readings whose sensors didn't read", () => {
    assert.equal(isShelfSensorData(shelf), true);
    assert.equal(isShelfSensorData({
      ...shelf, temperature_c: null, humidity_pct: null, light_lux: null,
      water_temp_c: null, water_level_ok: null, ph: null,
    }), true);
  });

  it("rejects malformed shelf readings", () => {
    assert.equal(isShelfSensorData({ ...shelf, ph: "6.2" }), false);
    assert.equal(isShelfSensorData({ ...shelf, water_level_ok: 1 }), false);
    assert.equal(isShelfSensorData({ ...shelf, level: 0.5 }), false);
    const { water_temp_c: _, ...missing } = shelf;
    assert.equal(isShelfSensorData(missing), false);
  });

  it("validates alerts", () => {
    const alert = {
      alert_id: "a1", severity: "critical", source: "robot-1", source_type: "robot",
      message: "lost", metric: "", value: 0, threshold: 0, timestamp: 1,
    };
    assert.equal(isFarmAlert(alert), true);
    assert.equal(isFarmAlert({ ...alert, severity: "urgent" }), false);
    assert.equal(isFarmAlert({ ...alert, value: null }), false);
  });
});
