// The seam between the farm UI and wherever farm data comes from.
//
// The planned dashboard data service (local Pi / MQTT over WebSocket when on
// the farm network, Supabase when on Vercel) implements FarmDataSource and is
// registered with setFarmDataSource(). The map and control panel only ever
// talk to this interface, so they work unchanged in both modes.

import { createLocalSource } from "@/lib/farm/local-source";
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

/**
 * Whether this source can reach the farm right now. `reason` says why not,
 * in words for the operator.
 */
export type FarmConnection =
  | { state: "connected" }
  | { state: "connecting" | "offline"; reason: string };

export interface FarmDataSource {
  /**
   * "local" when talking to the Pi on the farm network, "remote" through
   * Supabase. Manual driving (jog) is only offered in local mode.
   */
  readonly mode: "local" | "remote";
  /** Farm layout, or null to keep the default layout */
  getTopology(): Promise<FarmTopology | null>;
  /** Streams the full robot list whenever any robot changes. Returns unsubscribe. */
  subscribeRobots(onRobots: (robots: RobotView[]) => void): () => void;
  sendCommand(request: CommandRequest, operatorKey: string): Promise<CommandRecord>;
  listRecentCommands(robotId?: string): Promise<CommandRecord[]>;
  /** Streams the farm connection state, starting with the current one. Returns unsubscribe. */
  subscribeConnection(onChange: (connection: FarmConnection) => void): () => void;
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

/** Recent commands, newest first, from a GET endpoint returning { commands } */
export async function listCommandsFrom(endpoint: string, robotId?: string) {
  const query = robotId ? `?robot_id=${encodeURIComponent(robotId)}` : "";
  const response = await fetch(`${endpoint}${query}`, { cache: "no-store" });
  const payload = await readJson<{ commands: CommandRecord[] }>(response);
  return payload.commands;
}

/**
 * Default source until the data service lands: default topology, no robot
 * stream, and commands through this app's /api/commands route (Supabase).
 */
export const dashboardApiSource: FarmDataSource = {
  mode: "remote",
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
  listRecentCommands(robotId) {
    return listCommandsFrom("/api/commands", robotId);
  },
  subscribeConnection(onChange) {
    onChange({
      state: "offline",
      reason: "Remote access to the farm isn't set up yet: the Supabase bridge will report the farm's status.",
    });
    return () => undefined;
  },
};

// Until the data service detects local vs remote on its own: set
// NEXT_PUBLIC_MQTT_WS_URL (e.g. ws://192.168.4.1:9001) for the live local source,
// and NEXT_PUBLIC_DASHBOARD_API_URL for its command history.
const LOCAL_MQTT_URL = process.env.NEXT_PUBLIC_MQTT_WS_URL;

let activeSource: FarmDataSource = LOCAL_MQTT_URL
  ? createLocalSource(LOCAL_MQTT_URL, process.env.NEXT_PUBLIC_DASHBOARD_API_URL)
  : dashboardApiSource;
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
