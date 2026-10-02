import {
  TOPICS,
  createMqttClient,
  extractIdFromTopic,
  type FarmAlert,
  type TypedMqttClient,
} from "@farm/shared";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { ThresholdEvaluator, type AlertSourceType } from "./evaluator.js";
import { isElevatorTelemetry, isRobotTelemetry, isShelfSensorData } from "./validate.js";

const BROKER_URL = process.env.BROKER_URL ?? "mqtt://localhost:1883";
const CONFIG_PATH = process.env.CONFIG_PATH ?? fileURLToPath(new URL("../config.json", import.meta.url));

async function main() {
  const config = loadConfig(CONFIG_PATH);
  const evaluator = new ThresholdEvaluator(config.thresholds, config.cooldown_ms);
  const mqtt = await createMqttClient({ serviceName: "alert-engine", brokerUrl: BROKER_URL });

  console.log("\nAlert engine running");
  console.log(`   Broker: ${BROKER_URL}`);
  console.log(`   Config: ${CONFIG_PATH}`);
  console.log(`   Thresholds: ${config.thresholds.length}`);
  console.log(`   Cooldown: ${config.cooldown_ms}ms\n`);

  subscribe(mqtt, TOPICS.robot.telemetryAll, "robot", "robot_id", isRobotTelemetry, evaluator);
  subscribe(mqtt, TOPICS.shelf.sensorsAll, "shelf", "shelf_id", isShelfSensorData, evaluator);
  subscribe(mqtt, TOPICS.elevator.telemetryAll, "elevator", "elevator_id", isElevatorTelemetry, evaluator);

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    console.log("\nAlert engine shutting down");
    await mqtt.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function subscribe(
  mqtt: TypedMqttClient,
  topic: string,
  sourceType: AlertSourceType,
  idField: "robot_id" | "shelf_id" | "elevator_id",
  validator: (value: unknown) => value is Record<string, unknown>,
  evaluator: ThresholdEvaluator,
) {
  mqtt.subscribe<unknown>(topic, (payload, receivedTopic) => {
    if (!validator(payload)) {
      console.warn(`[ALERT] Ignoring invalid ${sourceType} telemetry on ${receivedTopic}`);
      return;
    }

    const topicId = extractIdFromTopic(receivedTopic);
    const payloadId = payload[idField] as string;
    if (!topicId || topicId !== payloadId) {
      console.warn(`[ALERT] Ignoring ${sourceType} telemetry with mismatched topic and payload ids`);
      return;
    }

    for (const alert of evaluator.evaluate({ source: topicId, sourceType, values: payload })) {
      mqtt.publish<FarmAlert>(TOPICS.alerts, alert);
      console.log(`[ALERT] ${alert.severity.toUpperCase()} ${alert.message}`);
    }
  });
}

main().catch((error) => {
  console.error("Alert engine failed:", error);
  process.exit(1);
});
