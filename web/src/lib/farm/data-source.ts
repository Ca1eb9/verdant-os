// The seam between the farm UI and wherever farm data comes from.
//
// The planned dashboard data service (local Pi / MQTT over WebSocket when on
// the farm network, Supabase when on Vercel) implements FarmDataSource and is
// registered with setFarmDataSource(). The map and control panel only ever
// talk to this interface, so they work unchanged in both modes.

import type { RobotView } from "@/lib/farm/robots";
import type { FarmTopology, RobotCommand } from "@/lib/farm/types";

export type CommandStatus = "pending" | "sent" | "failed";

export interface CommandRecord {
  id: string;
  robot_id: string;
  command: RobotCommand;
  issued_by: string;
  issued_at: number;
  status: CommandStatus;
  error?: string | null;
}

/** What the operator fills in; the source adds id / issued_at / source */
export interface CommandRequest {
  robot_id: string;
  command: Omit<RobotCommand, "source">;
}

export interface FarmDataSource {
  /** Farm layout, or null to keep the default layout */
  getTopology(): Promise<FarmTopology | null>;
  /** Streams the full robot list whenever any robot changes. Returns unsubscribe. */
  subscribeRobots(onRobots: (robots: RobotView[]) => void): () => void;
  sendCommand(request: CommandRequest, operatorKey: string): Promise<CommandRecord>;
  listRecentCommands(robotId?: string): Promise<CommandRecord[]>;
}

export class CommandError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new CommandError(payload.error ?? `Request failed (${response.status})`, response.status);
  }
  return payload;
}

/**
 * Default source until the data service lands: default topology, no robot
 * stream, and commands through this app's /api/commands route (Supabase).
 */
export const dashboardApiSource: FarmDataSource = {
  async getTopology() {
    return null;
  },
  subscribeRobots(onRobots) {
    onRobots([]);
    return () => undefined;
  },
  async sendCommand(request, operatorKey) {
    const response = await fetch("/api/commands", {
      method: "POST",
      headers: { "content-type": "application/json", "x-operator-key": operatorKey },
      body: JSON.stringify(request),
    });
    const payload = await readJson<{ command: CommandRecord }>(response);
    return payload.command;
  },
  async listRecentCommands(robotId) {
    const query = robotId ? `?robot_id=${encodeURIComponent(robotId)}` : "";
    const response = await fetch(`/api/commands${query}`, { cache: "no-store" });
    const payload = await readJson<{ commands: CommandRecord[] }>(response);
    return payload.commands;
  },
};

let activeSource: FarmDataSource = dashboardApiSource;
const listeners = new Set<() => void>();

export function getFarmDataSource() {
  return activeSource;
}

/** Swap in another data source (e.g. the local/remote data service) */
export function setFarmDataSource(source: FarmDataSource) {
  activeSource = source;
  listeners.forEach((listener) => listener());
}

export function onFarmDataSourceChange(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
