// ============================================================
// MQTT topics the dashboard uses.
//
// Mirrors the matching entries of farm-controller/shared/src/topics.ts.
// Vercel only builds web/, so the shared package cannot be imported
// directly. Keep in sync.
// ============================================================

export const TOPICS = {
  robot: {
    telemetryAll: "farm/robot/+/telemetry",
    /** Orchestrator's view of each robot (retained): assigned task, path */
    stateAll: "farm/robot/+/state",
  },
  commands: {
    /** The only path the orchestrator accepts jog on */
    local: "farm/commands/local",
    /** Remote commands, relayed from Supabase by the farm's bridge */
    remote: "farm/commands/remote",
    /** Commands from any source */
    all: "farm/commands/+",
  },
  system: {
    /** The farm layout (retained, published by the orchestrator) */
    topology: "farm/system/topology",
  },
} as const;

/** "farm/robot/robot-1/telemetry" → "robot-1" */
export function extractIdFromTopic(topic: string): string | null {
  const parts = topic.split("/");
  return parts.length >= 4 ? parts[2] : null;
}
