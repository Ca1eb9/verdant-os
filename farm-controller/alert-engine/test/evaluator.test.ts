import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AlertSeverity, type SensorThreshold } from "@farm/shared";
import { ThresholdEvaluator } from "../src/evaluator.js";

const threshold: SensorThreshold = {
  metric: "temperature_c",
  min: 15,
  max: 35,
  severity: AlertSeverity.WARNING,
  message_template: "{source} {metric}={value}; expected {min}-{max}",
};

describe("ThresholdEvaluator", () => {
  it("publishes the crossed boundary in an alert", () => {
    const evaluator = new ThresholdEvaluator([threshold], 60_000);
    const alerts = evaluator.evaluate({
      source: "shelf-1",
      sourceType: "shelf",
      values: { temperature_c: 40 },
    }, 1_000);

    assert.equal(alerts.length, 1);
    assert.deepEqual(alerts[0], {
      alert_id: alerts[0].alert_id,
      severity: AlertSeverity.WARNING,
      source: "shelf-1",
      source_type: "shelf",
      message: "shelf-1 temperature_c=40; expected 15-35",
      metric: "temperature_c",
      value: 40,
      threshold: 35,
      timestamp: 1_000,
    });
  });

  it("suppresses repeat alerts until the cooldown expires", () => {
    const evaluator = new ThresholdEvaluator([threshold], 100);
    const reading = { source: "robot-1", sourceType: "robot" as const, values: { temperature_c: 10 } };

    assert.equal(evaluator.evaluate(reading, 1_000).length, 1);
    assert.equal(evaluator.evaluate(reading, 1_099).length, 0);
    assert.equal(evaluator.evaluate(reading, 1_100).length, 1);
  });

  it("alerts immediately after a metric recovers and violates again", () => {
    const evaluator = new ThresholdEvaluator([threshold], 60_000);
    const reading = { source: "robot-1", sourceType: "robot" as const };

    assert.equal(evaluator.evaluate({ ...reading, values: { temperature_c: 40 } }, 1_000).length, 1);
    assert.equal(evaluator.evaluate({ ...reading, values: { temperature_c: 25 } }, 1_001).length, 0);
    assert.equal(evaluator.evaluate({ ...reading, values: { temperature_c: 40 } }, 1_002).length, 1);
  });

  it("keeps cooldown state separate by device and metric", () => {
    const evaluator = new ThresholdEvaluator([threshold], 60_000);
    const values = { temperature_c: 40 };

    assert.equal(evaluator.evaluate({ source: "robot-1", sourceType: "robot", values }, 1_000).length, 1);
    assert.equal(evaluator.evaluate({ source: "robot-2", sourceType: "robot", values }, 1_001).length, 1);
  });

  it("ignores absent, null, and non-numeric readings", () => {
    const evaluator = new ThresholdEvaluator([threshold], 60_000);
    const base = { source: "shelf-1", sourceType: "shelf" as const };

    assert.equal(evaluator.evaluate({ ...base, values: {} }).length, 0);
    assert.equal(evaluator.evaluate({ ...base, values: { temperature_c: null } }).length, 0);
    assert.equal(evaluator.evaluate({ ...base, values: { temperature_c: "hot" } }).length, 0);
  });
});
