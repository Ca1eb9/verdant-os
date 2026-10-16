import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type RobotEvent, type RobotState, type RobotTelemetry, RobotEventType, RobotStatus } from "@farm/shared";
import { loadConfig } from "../src/config.js";
import { processEvent, processTelemetry, processWatchdog } from "../src/state-machine.js";

const config = loadConfig();
const NOW = 1_000_000;

function robot(): RobotState {
  return {
    id: "robot-1",
    status: RobotStatus.IDLE,
    current_node: "cp-01",
    heading: null,
    battery_pct: 100,
    assigned_task: null,
    expected_path: [],
    waypoints_hit: [],
    last_seen: NOW,
    dock_requested_at: null,
    battery_critical_alerted: false,
  };
}

function telemetry(status: RobotStatus, battery_pct: number): RobotTelemetry {
  return {
    robot_id: "robot-1",
    status,
    current_node: "cp-01",
    task_id: null,
    last_completed_task_id: null,
    battery_pct,
    heading: null,
    timestamp: NOW,
  };
}

function alerts(state: RobotState, status: RobotStatus, battery: number, now = NOW) {
  return processTelemetry(state, telemetry(status, battery), config, now, false).effects.filter(
    (e) => e.type === "publish_alert",
  );
}

describe("critical battery alert", () => {
  it("alerts in manual, with no return to dock", () => {
    const state = robot();
    const { effects } = processTelemetry(
      state, telemetry(RobotStatus.MANUAL, config.battery_critical_pct - 1), config, NOW, false,
    );
    const alert = effects.find((e) => e.type === "publish_alert");
    assert.ok(alert && alert.type === "publish_alert" && alert.message.includes("manual"));
    assert.ok(!effects.some((e) => e.type === "send_command"));
  });

  it("alerts once per drop, re-armed above the low threshold", () => {
    const state = robot();
    const critical = config.battery_critical_pct;
    assert.equal(alerts(state, RobotStatus.STOPPED, critical - 1).length, 1);
    // sag and recovery around the threshold: no repeat
    assert.equal(alerts(state, RobotStatus.STOPPED, critical + 1).length, 0);
    assert.equal(alerts(state, RobotStatus.STOPPED, critical - 1).length, 0);
    // charged above low, then down again: a new alert
    assert.equal(alerts(state, RobotStatus.STOPPED, config.battery_low_pct + 1).length, 0);
    assert.equal(alerts(state, RobotStatus.STOPPED, critical - 1).length, 1);
  });

  it("says returning to dock when the return is sent", () => {
    const state = robot();
    const result = processTelemetry(
      state, telemetry(RobotStatus.EN_ROUTE, config.battery_critical_pct - 1), config, NOW, false,
    );
    const alert = result.effects.find((e) => e.type === "publish_alert");
    assert.ok(alert && alert.type === "publish_alert" && alert.message.endsWith("returning to dock"));
    assert.ok(result.effects.some((e) => e.type === "send_command"));
    // resent dock request later: still one alert
    assert.equal(
      alerts(state, RobotStatus.EN_ROUTE, config.battery_critical_pct - 2, NOW + config.command_ack_timeout_ms + 1).length,
      0,
    );
  });
});

function event(type: RobotEventType, details?: string): RobotEvent {
  return { robot_id: "robot-1", event: type, details, timestamp: NOW };
}

describe("charging", () => {
  it("raises a warning when the battery stops rising while charging", () => {
    const state = { ...robot(), status: RobotStatus.CHARGING };
    const { effects } = processEvent(state, event(RobotEventType.CHARGE_STALLED, "35.0%, no rise in 30 min"), config);
    assert.equal(effects.length, 1);
    const alert = effects[0];
    assert.ok(alert.type === "publish_alert" && alert.severity === "warning" && alert.message.includes("35.0%"));
  });

  it("re-arms the critical battery alert on any completed charge, however full", () => {
    const state = robot();
    const critical = config.battery_critical_pct;
    assert.equal(alerts(state, RobotStatus.STOPPED, critical - 1).length, 1);
    // the operator ended the charge below the low threshold: the next drop alerts again
    state.status = RobotStatus.CHARGING;
    processEvent(state, event(RobotEventType.CHARGE_COMPLETE, "12.0%, ended by operator"), config);
    assert.equal(alerts(state, RobotStatus.STOPPED, critical - 1).length, 1);
  });
});

describe("lost robot alerts", () => {
  it("raises the lost problem and resolves it on recovery", () => {
    const state = robot();
    const lost = processWatchdog(state, NOW + config.heartbeat_timeout_ms + 1, config).effects
      .find((e) => e.type === "publish_alert");
    assert.ok(lost && lost.type === "publish_alert" && lost.problem === "lost");

    const [recovered] = alerts(state, RobotStatus.IDLE, 100);
    assert.ok(recovered && recovered.type === "publish_alert" && recovered.resolves === "lost");
  });
});
