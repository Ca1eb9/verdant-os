import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isAlertThresholds } from "../src/validate.js";

const limits = { metric: "ph", warning_min: 5.8, warning_max: 6.8, critical_min: 5.5, critical_max: 7.2 };

describe("alert thresholds validation", () => {
  it("accepts what the alert engine publishes", () => {
    assert.ok(isAlertThresholds({ thresholds: [limits] }));
    assert.ok(isAlertThresholds({ thresholds: [] }));
  });

  it("refuses a missing list, a nameless metric or a limit that isn't a number", () => {
    assert.ok(!isAlertThresholds({}));
    assert.ok(!isAlertThresholds({ thresholds: [{ ...limits, metric: "" }] }));
    assert.ok(!isAlertThresholds({ thresholds: [{ ...limits, critical_max: "7.2" }] }));
    assert.ok(!isAlertThresholds({ thresholds: [{ ...limits, warning_min: null }] }));
  });
});
