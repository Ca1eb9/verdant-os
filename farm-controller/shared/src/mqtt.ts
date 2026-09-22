// ============================================================
// Typed MQTT client wrapper
//
// Thin layer over mqtt.js that handles:
//   - JSON serialization/deserialization
//   - Typed publish and subscribe
//   - Auto-reconnect with logging
//   - Graceful shutdown
//
// Usage:
//   const client = await createMqttClient({ serviceName: "orchestrator" });
//   client.subscribe(TOPICS.robot.telemetryAll, (msg, topic) => {
//     const robotId = extractIdFromTopic(topic);
//     console.log(robotId, msg.battery_pct);
//   });
//   client.publish(TOPICS.robot.command("robot-1"), command);
// ============================================================

import mqtt, { MqttClient, IClientOptions } from "mqtt";

export interface MqttConfig {
  /** Broker URL, default "mqtt://localhost:1883" */
  brokerUrl?: string;
  /** Service name, used as client ID prefix */
  serviceName: string;
  onConnect?: () => void;
  onDisconnect?: () => void;
}

export interface TypedMqttClient {
  publish<T>(topic: string, payload: T, retain?: boolean): void;

  subscribe<T>(topic: string, handler: (payload: T, topic: string) => void): void;

  unsubscribe(topic: string): void;

  disconnect(): Promise<void>;

  /** The underlying mqtt.js client, if need be */
  raw: MqttClient;
}

export async function createMqttClient(config: MqttConfig): Promise<TypedMqttClient> {
  const brokerUrl = config.brokerUrl ?? "mqtt://localhost:1883";

  const options: IClientOptions = {
    clientId: `${config.serviceName}-${Date.now().toString(36)}`,
    clean: true,
    reconnectPeriod: 5000,
    connectTimeout: 10000,
  };

  const client = mqtt.connect(brokerUrl, options);
  const handlers = new Map<string, Set<(payload: unknown, topic: string) => void>>();

  return new Promise((resolve, reject) => {
    client.on("connect", () => {
      console.log(`[mqtt] ${config.serviceName} connected to ${brokerUrl}`);
      config.onConnect?.();

      // Re-subscribe to all registered topics on reconnect
      for (const topic of handlers.keys()) {
        client.subscribe(topic);
      }

      resolve(buildClient());
    });

    client.on("error", (err) => {
      console.error(`[mqtt] ${config.serviceName} error:`, err.message);
      reject(err);
    });

    client.on("offline", () => {
      console.warn(`[mqtt] ${config.serviceName} offline, will reconnect`);
      config.onDisconnect?.();
    });

    client.on("message", (topic, buffer) => {
      let payload: unknown;
      try {
        payload = JSON.parse(buffer.toString());
      } catch {
        console.warn(`[mqtt] Non-JSON message on ${topic}:`, buffer.toString());
        return;
      }

      // Match against subscribed patterns (handles + wildcards)
      for (const [pattern, fns] of handlers) {
        if (topicMatches(pattern, topic)) {
          for (const fn of fns) {
            try {
              fn(payload, topic);
            } catch (err) {
              console.error(`[mqtt] Handler error on ${topic}:`, err);
            }
          }
        }
      }
    });

    function buildClient(): TypedMqttClient {
      return {
        publish<T>(topic: string, payload: T, retain = false) {
          const data = JSON.stringify(payload);
          client.publish(topic, data, { retain, qos: 1 });
        },

        subscribe<T>(topic: string, handler: (payload: T, topic: string) => void) {
          if (!handlers.has(topic)) {
            handlers.set(topic, new Set());
            client.subscribe(topic, { qos: 1 });
          }
          handlers.get(topic)!.add(handler as (payload: unknown, topic: string) => void);
        },

        unsubscribe(topic: string) {
          handlers.delete(topic);
          client.unsubscribe(topic);
        },

        async disconnect() {
          return new Promise<void>((res) => {
            client.end(false, () => {
              console.log(`[mqtt] ${config.serviceName} disconnected`);
              res();
            });
          });
        },

        raw: client,
      };
    }
  });
}

// --- MQTT topic matching (supports + and # wildcards) --------

function topicMatches(pattern: string, topic: string): boolean {
  const patternParts = pattern.split("/");
  const topicParts = topic.split("/");

  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i] === "#") return true;
    if (patternParts[i] === "+") continue;
    if (patternParts[i] !== topicParts[i]) return false;
  }

  return patternParts.length === topicParts.length;
}
