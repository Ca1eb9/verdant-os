import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AlertSeverity, type SensorThreshold } from "@farm/shared";
import { ThresholdEvaluator, type Reading } from "../src/evaluator.js";

const threshold: SensorThreshold = {
  metric: "temperature_c",
  warning_min: 18,
  warning_max: 28,
  critical_min: 16,
  critical_max: 30,
  deadband: 1,
  message_template: "{source} {value} is {direction} the {severity} limit of {limit}",
  resolved_template: "{source} is back at {value}",
};

const HOLD = 30_000;
const COOLDOWN = 600_000;

const shelf = (values: Record<string, unknown>): Reading => ({ source: "shelf-1", sourceType: "shelf", values });
const temp = (value: number | null) => shelf({ temperature_c: value });

/** Feeds the same reading at each time and returns the severities published, with reminders marked */
function run(evaluator: ThresholdEvaluator, steps: Array<[number, Reading]>) {
  return steps.flatMap(([now, reading]) =>
    evaluator.evaluate(reading, now).map(({ alert, reminder }) => `${now}:${alert.severity}${reminder ? "*" : ""}`));
}

describe("ThresholdEvaluator", () => {
  it("raises nothing for a one-off spike", () => {
    const evaluator = new ThresholdEvaluator([threshold], HOLD, COOLDOWN);
    assert.deepEqual(run(evaluator, [[0, temp(35)], [1_000, temp(22)], [40_000, temp(22)]]), []);
  });

  it("raises after the hold time with the crossed limit", () => {
    const evaluator = new ThresholdEvaluator([threshold], HOLD, COOLDOWN);
    assert.equal(evaluator.evaluate(temp(29), 0).length, 0);
    assert.equal(evaluator.evaluate(temp(29), 29_999).length, 0);
    const [{ alert, reminder }] = evaluator.evaluate(temp(29), 30_000, 1_234);

    assert.equal(reminder, false);
    assert.deepEqual(alert, {
      alert_id: alert.alert_id,
      severity: AlertSeverity.WARNING,
      source: "shelf-1",
      source_type: "shelf",
      message: "shelf-1 29 is above the warning limit of 28",
      metric: "temperature_c",
      value: 29,
      threshold: 28,
      timestamp: 1_234,
      resolves: null,
    });
  });

  it("escalates a warning to critical only after the hold time", () => {
    const evaluator = new ThresholdEvaluator([threshold], HOLD, COOLDOWN);
    assert.deepEqual(run(evaluator, [
      [0, temp(17)], [30_000, temp(17)],
      [31_000, temp(15)], [60_000, temp(15)], [61_000, temp(15)],
    ]), ["30000:warning", "61000:critical"]);
  });

  it("names the critical limit and the direction when low", () => {
    const evaluator = new ThresholdEvaluator([threshold], 0, COOLDOWN);
    const [{ alert }] = evaluator.evaluate(temp(15.456), 0);
    assert.equal(alert.threshold, 16);
    assert.equal(alert.message, "shelf-1 15.46 is below the critical limit of 16");
  });

  it("doesn't flap on a value sitting on a limit", () => {
    const evaluator = new ThresholdEvaluator([threshold], 0, COOLDOWN);
    // Inside the limit but within the deadband: stays raised, no new alert
    assert.deepEqual(run(evaluator, [[0, temp(29)], [1, temp(28)], [2, temp(29)], [3, temp(27.5)], [4, temp(29)]]),
      ["0:warning"]);
    // Past the deadband: clears, so the next violation is a new alert
    assert.deepEqual(run(evaluator, [[5, temp(27)], [6, temp(29)]]), ["5:info", "6:warning"]);
  });

  it("eases critical to warning at once, resolving the critical alert", () => {
    const evaluator = new ThresholdEvaluator([threshold], HOLD, COOLDOWN);
    evaluator.evaluate(temp(31), 0);
    const [{ alert: critical }] = evaluator.evaluate(temp(31), 30_000);
    const [{ alert: eased }] = evaluator.evaluate(temp(28.5), 30_001);
    assert.equal(eased.severity, AlertSeverity.WARNING);
    assert.equal(eased.resolves, critical.alert_id);
    assert.equal(eased.threshold, 28);
    // Raised at warning now, so going back to critical needs the hold again
    assert.deepEqual(run(evaluator, [[30_002, temp(31)], [60_001, temp(31)], [60_002, temp(31)]]), ["60002:critical"]);
  });

  it("resolves the last alert, reminder included, when back in range", () => {
    const evaluator = new ThresholdEvaluator([threshold], 0, COOLDOWN);
    evaluator.evaluate(temp(29), 0);
    const [{ alert: reminder }] = evaluator.evaluate(temp(29), COOLDOWN);
    const [{ alert: cleared, reminder: isReminder }] = evaluator.evaluate(temp(22.004), COOLDOWN + 1);
    assert.equal(isReminder, false);
    assert.deepEqual({ ...cleared, alert_id: "" }, {
      alert_id: "",
      severity: AlertSeverity.INFO,
      source: "shelf-1",
      source_type: "shelf",
      message: "shelf-1 is back at 22",
      metric: "temperature_c",
      value: 22.004,
      threshold: 28,
      timestamp: cleared.timestamp,
      resolves: reminder.alert_id,
    });
    // Only once: staying in range publishes nothing more
    assert.equal(evaluator.evaluate(temp(22), COOLDOWN * 3).length, 0);
  });

  it("doesn't resolve a spike that never raised", () => {
    const evaluator = new ThresholdEvaluator([threshold], HOLD, COOLDOWN);
    assert.deepEqual(run(evaluator, [[0, temp(31)], [10_000, temp(22)]]), []);
  });

  it("reminds once per cooldown while the band holds", () => {
    const evaluator = new ThresholdEvaluator([threshold], 0, COOLDOWN);
    assert.deepEqual(run(evaluator, [
      [0, temp(29)], [COOLDOWN - 1, temp(29)], [COOLDOWN, temp(29)], [COOLDOWN + 1, temp(29)],
    ]), ["0:warning", `${COOLDOWN}:warning*`]);
  });

  it("keeps state through readings that are null or absent", () => {
    const evaluator = new ThresholdEvaluator([threshold], HOLD, COOLDOWN);
    assert.deepEqual(run(evaluator, [
      [0, temp(29)], [10_000, temp(null)], [20_000, shelf({})], [30_000, temp(29)], [31_000, temp(null)],
    ]), ["30000:warning"]);
    assert.deepEqual(run(evaluator, [[32_000, temp(29)]]), []);
  });

  it("keeps state separate by device and metric", () => {
    const humidity: SensorThreshold = { ...threshold, metric: "humidity_pct" };
    const evaluator = new ThresholdEvaluator([threshold, humidity], 0, COOLDOWN);
    const robot = (values: Record<string, unknown>): Reading => ({ source: "robot-1", sourceType: "robot", values });

    assert.equal(evaluator.evaluate(shelf({ temperature_c: 29, humidity_pct: 29 }), 0).length, 2);
    assert.equal(evaluator.evaluate(robot({ temperature_c: 29 }), 1).length, 1);
    assert.equal(evaluator.evaluate(shelf({ temperature_c: 29, humidity_pct: 29 }), 2).length, 0);
  });

  it("raises a held critical alert for a low reservoir and ignores null", () => {
    const evaluator = new ThresholdEvaluator([threshold], HOLD, COOLDOWN);
    const level = (ok: boolean | null) => shelf({ water_level_ok: ok });
    assert.deepEqual(run(evaluator, [[0, level(false)], [10_000, level(null)], [20_000, level(true)]]), []);

    evaluator.evaluate(level(false), 30_000);
    const [{ alert }] = evaluator.evaluate(level(false), 60_000);
    assert.equal(alert.severity, AlertSeverity.CRITICAL);
    assert.equal(alert.resolves, null);
    assert.equal(alert.metric, "water_level_ok");
    assert.equal(alert.value, 0);
    assert.equal(alert.threshold, 1);
    assert.equal(alert.message, "shelf-1 reservoir is below the level sensor. Refill it.");
    // Refilled clears at once, resolving it; the next drop is a new alert after the hold
    const [{ alert: refilled }] = evaluator.evaluate(level(true), 61_000);
    assert.equal(refilled.severity, AlertSeverity.INFO);
    assert.equal(refilled.resolves, alert.alert_id);
    assert.equal(refilled.value, 1);
    assert.equal(refilled.message, "shelf-1 reservoir is back above the level sensor");
    assert.deepEqual(run(evaluator, [[62_000, level(false)], [92_000, level(false)]]), ["92000:critical"]);
  });

  it("keeps open alerts across a restart, so a clear still resolves them", () => {
    const before = new ThresholdEvaluator([threshold], 0, COOLDOWN);
    const [{ alert }] = before.evaluate(temp(31), 0);
    const saved = JSON.parse(JSON.stringify(before.openAlerts()));
    assert.deepEqual(saved, { "shelf:shelf-1:temperature_c": { band: "criticalHigh", alert_id: alert.alert_id } });

    const after = new ThresholdEvaluator([threshold], 0, COOLDOWN);
    after.restore({ ...saved, bad: { band: "ok", alert_id: "x" }, worse: null }, 5);
    // Still out of range: no new alert, as before the restart
    assert.equal(after.evaluate(temp(31), 6).length, 0);
    const [{ alert: cleared }] = after.evaluate(temp(22), 7);
    assert.equal(cleared.resolves, alert.alert_id);
    assert.deepEqual(after.openAlerts(), {});
  });
});
