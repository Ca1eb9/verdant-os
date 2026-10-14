// ============================================================
// Clear alerts
//
// Publishes farm/alerts/clear once. The ingester deletes its stored
// alerts, the alert engine, orchestrator and shelf bridge forget their
// open ones (a problem that's still there is raised again), the
// Supabase bridge deletes this farm's alerts rows, and open dashboards
// empty their lists.
//
// Run on the Pi:  npm run clear-alerts
// ============================================================

import { TOPICS, createMqttClient, type AlertsCleared } from "@farm/shared";

const BROKER_URL = process.env.BROKER_URL ?? "mqtt://localhost:1883";

async function main() {
  const mqtt = await createMqttClient({ serviceName: "clear-alerts", brokerUrl: BROKER_URL });
  mqtt.publish<AlertsCleared>(TOPICS.alertsClear, { timestamp: Date.now() });
  // Waits for the broker to take the message before closing
  await mqtt.disconnect();
  console.log(`Cleared alerts: sent ${TOPICS.alertsClear} to ${BROKER_URL}.`);
  console.log("Services that are running log it (journalctl -u farm-ingester -n 5); stopped ones keep their alerts.");
}

main().catch((error) => {
  console.error("Could not clear alerts:", error);
  process.exit(1);
});
