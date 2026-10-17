import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig, parseConfig } from "../src/config.js";

describe("parseConfig", () => {
  it("accepts the checked-in config", () => {
    const path = fileURLToPath(new URL("../../orchestrator-config.json", import.meta.url));
    assert.equal(loadConfig(path).robot_plants.length, 1);
  });

  it("fills missing keys with defaults", () => {
    assert.deepEqual(parseConfig({}), loadConfig());
    assert.equal(parseConfig({ battery_low_pct: 30 }).battery_low_pct, 30);
  });

  it("warns on an unknown key but still loads", () => {
    assert.equal(parseConfig({ charge_complete_pct: 80 }).battery_low_pct, loadConfig().battery_low_pct);
  });

  it("rejects a value of the wrong type", () => {
    assert.throws(() => parseConfig({ unknown_node_alert_count: "3" }), /unknown_node_alert_count/);
    assert.throws(() => parseConfig({ battery_failsafe: "false" }), /battery_failsafe/);
    assert.throws(() => parseConfig({ robot_plants: {} }), /robot_plants/);
  });

  it("rejects out-of-range values", () => {
    assert.throws(() => parseConfig({ watchdog_interval_ms: 0 }), /watchdog_interval_ms/);
    assert.throws(() => parseConfig({ battery_low_pct: 120 }), /battery_low_pct/);
    assert.throws(() => parseConfig({ max_task_retries: 1.5 }), /max_task_retries/);
    assert.throws(() => parseConfig({ unknown_node_alert_count: 0 }), /unknown_node_alert_count/);
    assert.throws(() => parseConfig({ battery_critical_pct: 25, battery_low_pct: 20 }), /battery_critical_pct/);
  });

  it("rejects a file that isn't a JSON object", () => {
    assert.throws(() => parseConfig([]), /JSON object/);
    assert.throws(() => loadConfig("/nonexistent/orchestrator-config.json"), /could not read config/);
  });
});
