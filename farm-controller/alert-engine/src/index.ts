// ============================================================
// Alert engine
//
// Watches robot and shelf sensor readings and publishes a FarmAlert
// to farm/alerts when one stays outside its configured range.
// Optionally emails every critical alert on farm/alerts, from any
// service, through Resend.
//
// Run:  npx tsx src/index.ts
// ============================================================

import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  AlertSeverity,
  TOPICS,
  createMqttClient,
  extractIdFromTopic,
  type FarmAlert,
  type TypedMqttClient,
} from "@farm/shared";
import { loadConfig } from "./config.js";
import { emailConfigFromEnv, sendAlertEmail, type EmailConfig } from "./email.js";
import { ThresholdEvaluator, type AlertSourceType } from "./evaluator.js";
import { isFarmAlert, isRobotTelemetry, isShelfSensorData } from "./validate.js";

const BROKER_URL = process.env.BROKER_URL ?? "mqtt://localhost:1883";
const CONFIG_PATH = process.env.CONFIG_PATH ?? "../../alert-engine-config.json";

/** Topics whose last payload was invalid, so a bad sender logs once, not on every message */
const invalidTopics = new Set<string>();
/**
 * Reminders this service published. Their echo on farm/alerts isn't emailed:
 * the first alert was, and a long outage shouldn't fill the inbox.
 */
const reminderIds = new Set<string>();
let email: EmailConfig | null = null;

async function main() {
  let config;
  try {
    config = loadConfig(fileURLToPath(new URL(CONFIG_PATH, import.meta.url)));
  } catch (error) {
    console.error(`[FATAL] Bad alert engine config: ${(error as Error).message}`);
    process.exit(1);
  }

  email = emailConfigFromEnv(process.env, (message) => console.warn(`[ALERT] ${message}`));
  const evaluator = new ThresholdEvaluator(config.thresholds, config.hold_ms, config.cooldown_ms);
  const mqtt = await createMqttClient({ serviceName: "alert-engine", brokerUrl: BROKER_URL });

  console.log("[ALERT] Alert engine running");
  console.log(`[ALERT]   broker:     ${BROKER_URL}`);
  console.log(`[ALERT]   config:     ${CONFIG_PATH}`);
  console.log(`[ALERT]   metrics:    ${config.thresholds.map((t) => t.metric).join(", ")}, water_level_ok`);
  console.log(`[ALERT]   hold:       ${config.hold_ms}ms, cooldown ${config.cooldown_ms}ms`);
  console.log(`[ALERT]   email:      ${email ? `critical alerts to ${email.to.length} address(es)` : "off"}`);

  subscribe(mqtt, TOPICS.robot.telemetryAll, "robot", "robot_id", isRobotTelemetry, evaluator);
  subscribe(mqtt, TOPICS.shelf.sensorsAll, "shelf", "shelf_id", isShelfSensorData, evaluator);

  if (email) {
    const emailConfig = email;
    mqtt.subscribe<unknown>(TOPICS.alerts, (payload) => {
      if (!isFarmAlert(payload)) return;
      if (reminderIds.delete(payload.alert_id)) return;
      if (payload.severity !== AlertSeverity.CRITICAL) return;
      void sendAlertEmail(emailConfig, payload).then((sent) => {
        if (sent) console.log(`[EMAIL] Sent: ${payload.message}`);
      });
    });
  }

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    console.log("[ALERT] Shutting down");
    await mqtt.disconnect();
    process.exit(0);
  };
  // systemd stops services with SIGINT (see the unit's KillSignal)
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function subscribe(
  mqtt: TypedMqttClient,
  topic: string,
  sourceType: AlertSourceType,
  idField: "robot_id" | "shelf_id",
  validator: (value: unknown) => value is Record<string, unknown>,
  evaluator: ThresholdEvaluator,
) {
  mqtt.subscribe<unknown>(topic, (payload, receivedTopic) => {
    const topicId = extractIdFromTopic(receivedTopic);
    const valid = validator(payload) && topicId !== null && payload[idField] === topicId;
    if (!valid) {
      if (!invalidTopics.has(receivedTopic)) {
        console.warn(`[ALERT] Ignoring invalid ${sourceType} telemetry on ${receivedTopic} (logged once until it's valid again)`);
        invalidTopics.add(receivedTopic);
      }
      return;
    }
    if (invalidTopics.delete(receivedTopic)) {
      console.log(`[ALERT] Valid ${sourceType} telemetry on ${receivedTopic} again`);
    }

    for (const { alert, reminder } of evaluator.evaluate({ source: topicId, sourceType, values: payload }, performance.now())) {
      if (reminder && email) reminderIds.add(alert.alert_id);
      mqtt.publish<FarmAlert>(TOPICS.alerts, alert);
      console.log(`[ALERT] ${alert.severity.toUpperCase()}${reminder ? " (still)" : ""}: ${alert.message}`);
    }
  });
}

main().catch((error) => {
  console.error("[FATAL] Alert engine failed:", error);
  process.exit(1);
});
