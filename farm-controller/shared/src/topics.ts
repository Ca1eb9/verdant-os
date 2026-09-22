// ============================================================
// MQTT topic definitions
//
// Convention:  farm/{device_type}/{id}/{channel}
// Wildcards:   + matches one level, # matches all remaining
//
// Every service imports these instead of hardcoding strings.
// If a topic changes, it changes here and nowhere else.
// ============================================================

export const TOPICS = {
  robot: {
    /** Telemetry from a specific robot */
    telemetry: (id: string) => `farm/robot/${id}/telemetry` as const,
    /** Command to a specific robot */
    command: (id: string) => `farm/robot/${id}/command` as const,
    /** Configuration push (e.g. graph update) to a specific robot */
    config: (id: string) => `farm/robot/${id}/config` as const,
    // inside robot:
    events: (id: string) => `farm/robot/${id}/events` as const,

    /** Subscribe to all robot telemetry */
    telemetryAll: "farm/robot/+/telemetry" as const,
    /** Subscribe to all robot commands (useful for logging) */
    commandAll: "farm/robot/+/command" as const,
    configAll: "farm/robot/+/config" as const,
    eventsAll: "farm/robot/+/events" as const,
  },

  elevator: {
    telemetry: (id: string) => `farm/elevator/${id}/telemetry` as const,
    command: (id: string) => `farm/elevator/${id}/command` as const,

    telemetryAll: "farm/elevator/+/telemetry" as const,
  },

  shelf: {
    /** Sensor readings from a specific shelf's sensor node */
    sensors: (id: string) => `farm/shelf/${id}/sensors` as const,

    /** Subscribe to all shelf sensor data */
    sensorsAll: "farm/shelf/+/sensors" as const,
  },

  /** Commands from external sources, bridged into local MQTT */
  commands: {
    local: "farm/commands/local" as const,
    remote: "farm/commands/remote" as const,
    /** Subscribe to commands from any source */
    all: "farm/commands/+" as const,
  },

  /** Farm-wide alerts from any service */
  alerts: "farm/alerts" as const,

  /** System-level topics */
  system: {
    /** Services publish heartbeats here */
    heartbeat: (service: string) => `farm/system/${service}/heartbeat` as const,
    /** Topology updates */
    topology: "farm/system/topology" as const,
  },
} as const;

// ============================================================
// Helpers for extracting IDs from topic strings
// ============================================================

/**
 * Extract the device ID from a topic string.
 * e.g. "farm/robot/robot-1/telemetry" → "robot-1"
 *      "farm/shelf/A3/sensors"         → "A3"
 */
export function extractIdFromTopic(topic: string): string | null {
  const parts = topic.split("/");
  // Convention: farm/{type}/{id}/{channel} → id is at index 2
  return parts.length >= 4 ? parts[2] : null;
}

/**
 * Extract the device type from a topic string.
 * e.g. "farm/robot/robot-1/telemetry" → "robot"
 */
export function extractTypeFromTopic(topic: string): string | null {
  const parts = topic.split("/");
  return parts.length >= 2 ? parts[1] : null;
}
