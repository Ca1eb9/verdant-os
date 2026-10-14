import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig, parseConfig } from "../src/config.js";

const validThreshold = {
  metric: "humidity_pct",
  warning_min: 40,
  warning_max: 70,
  critical_min: 35,
  critical_max: 80,
  deadband: 3,
  message_template: "Humidity is {value}",
  resolved_template: "Humidity is back at {value}",
};

const config = (thresholds: unknown[]) => ({ hold_ms: 30_000, cooldown_ms: 1_000, thresholds });

describe("parseConfig", () => {
  it("accepts a valid config", () => {
    assert.deepEqual(parseConfig(config([validThreshold])), config([validThreshold]));
  });

  it("accepts the checked-in config", () => {
    const path = fileURLToPath(new URL("../../alert-engine-config.json", import.meta.url));
    assert.ok(loadConfig(path).thresholds.length > 0);
  });

  it("rejects a warning band outside the critical band", () => {
    assert.throws(() => parseConfig(config([{ ...validThreshold, warning_min: 30 }])), /critical_min <= warning_min/);
    assert.throws(() => parseConfig(config([{ ...validThreshold, warning_max: 30 }])), /warning_min < warning_max/);
  });

  it("rejects missing limits, a negative deadband and a missing hold time", () => {
    assert.throws(() => parseConfig(config([{ ...validThreshold, critical_max: undefined }])), /critical_max/);
    assert.throws(() => parseConfig(config([{ ...validThreshold, deadband: -1 }])), /deadband/);
    assert.throws(() => parseConfig(config([{ ...validThreshold, resolved_template: "" }])), /resolved_template/);
    assert.throws(() => parseConfig({ cooldown_ms: 1_000, thresholds: [validThreshold] }), /hold_ms/);
  });

  it("rejects duplicate metrics", () => {
    assert.throws(() => parseConfig(config([validThreshold, validThreshold])), /duplicate threshold metric/);
  });
});
