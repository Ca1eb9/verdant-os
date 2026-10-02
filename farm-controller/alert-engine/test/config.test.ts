import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AlertSeverity } from "@farm/shared";
import { parseConfig } from "../src/config.js";

const validThreshold = {
  metric: "humidity_pct",
  min: 30,
  max: 85,
  severity: AlertSeverity.WARNING,
  message_template: "Humidity is {value}",
};

describe("parseConfig", () => {
  it("accepts a valid config", () => {
    assert.deepEqual(parseConfig({ cooldown_ms: 1_000, thresholds: [validThreshold] }), {
      cooldown_ms: 1_000,
      thresholds: [validThreshold],
    });
  });

  it("rejects invalid ranges", () => {
    assert.throws(
      () => parseConfig({ cooldown_ms: 1_000, thresholds: [{ ...validThreshold, min: 90 }] }),
      /min cannot exceed max/,
    );
  });

  it("rejects duplicate metrics", () => {
    assert.throws(
      () => parseConfig({ cooldown_ms: 1_000, thresholds: [validThreshold, validThreshold] }),
      /duplicate threshold metric/,
    );
  });
});
