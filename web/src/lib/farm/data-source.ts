// The seam between the farm UI and wherever farm data comes from.
//
// The planned dashboard data service (local Pi / MQTT over WebSocket when on
// the farm network, Supabase when on Vercel) implements FarmDataSource and is
// registered with setFarmDataSource(). The map and control panel only ever
// talk to this interface, so they work unchanged in both modes.
//
// A source serves one farm. On FarmNet that's the Pi's own farm; remotely,
// selectFarm() swaps in a source for the farm picked in the header.

import { createLocalSource } from "@/lib/farm/local-source";
import type { RobotView } from "@/lib/farm/robots";
import type { FarmAlert, FarmTopology, RobotCommand, ShelfSensorData } from "@/lib/farm/types";

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

/** A shelf's latest reading */
export interface ShelfReading {
  data: ShelfSensorData;
  /** Browser receive time: there's no clock sync with the Pi */
  receivedAt: number;
}

/**
 * Whether this source can reach the farm right now. `reason` says why not,
 * in plain words for the operator: no service names, addresses or settings
 * (log those to the console instead).
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
  /**
   * Streams the farm's alerts from its services (orchestrator, alert engine),
   * newest first, whenever one arrives; null when this source has no alerts
   * yet. Returns unsubscribe.
   */
  subscribeAlerts(onAlerts: (alerts: FarmAlert[] | null) => void): () => void;
  /**
   * Streams each shelf's latest sensor reading whenever one arrives; null when
   * this source has no shelf feed (the dashboard then polls sensor_events).
   * Returns unsubscribe.
   */
  subscribeShelves(onShelves: (shelves: ShelfReading[] | null) => void): () => void;
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
export async function listCommandsFrom(endpoint: string, robotId?: string, farmId?: string) {
  const params = new URLSearchParams();
  if (farmId) params.set("farm_id", farmId);
  if (robotId) params.set("robot_id", robotId);
  const query = params.toString();
  const response = await fetch(query ? `${endpoint}?${query}` : endpoint, { cache: "no-store" });
  const payload = await readJson<{ commands: CommandRecord[] }>(response);
  return payload.commands;
}

/**
 * Remote source for one farm until the data service lands: default topology,
 * no robot stream, and that farm's commands through this app's /api/commands
 * route (Supabase).
 */
export function createDashboardApiSource(farmId: string): FarmDataSource {
  return {
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
        body: JSON.stringify({ ...request, farm_id: farmId }),
      });
      const payload = await readJson<{ command: CommandRecord }>(response);
      return payload.command;
    },
    listRecentCommands(robotId) {
      return listCommandsFrom("/api/commands", robotId, farmId);
    },
    subscribeConnection(onChange) {
      onChange({
        state: "offline",
        reason: "Remote access isn't available yet.",
      });
      return () => undefined;
    },
    subscribeAlerts(onAlerts) {
      onAlerts(null);
      return () => undefined;
    },
    subscribeShelves(onShelves) {
      onShelves(null);
      return () => undefined;
    },
  };
}

/** Remote, with no farm picked (the farm list is loading, empty or failed) */
function noFarmSource(connection: FarmConnection): FarmDataSource {
  return {
    mode: "remote",
    async getTopology() {
      return null;
    },
    subscribeRobots(onRobots) {
      onRobots([]);
      return () => undefined;
    },
    async sendCommand() {
      throw new CommandError("No farm selected.", 400);
    },
    async listRecentCommands() {
      return [];
    },
    subscribeConnection(onChange) {
      onChange(connection);
      return () => undefined;
    },
    subscribeAlerts(onAlerts) {
      onAlerts(null);
      return () => undefined;
    },
    subscribeShelves(onShelves) {
      onShelves(null);
      return () => undefined;
    },
  };
}

// Until the data service detects local vs remote on its own: set
// NEXT_PUBLIC_MQTT_WS_URL (e.g. ws://192.168.4.1:9001) for the live local source,
// and NEXT_PUBLIC_DASHBOARD_API_URL for its command history.
const LOCAL_MQTT_URL = process.env.NEXT_PUBLIC_MQTT_WS_URL;

/** True when this dashboard runs on a farm's Pi: one farm, no farm picker */
export const ON_FARMNET = Boolean(LOCAL_MQTT_URL);

let activeSource: FarmDataSource = LOCAL_MQTT_URL
  ? createLocalSource(LOCAL_MQTT_URL, process.env.NEXT_PUBLIC_DASHBOARD_API_URL)
  : noFarmSource({ state: "connecting", reason: "Loading farms…" });
const listeners = new Set<() => void>();

export function getFarmDataSource() {
  return activeSource;
}

/** Swap in another data source (e.g. the local/remote data service) */
export function setFarmDataSource(source: FarmDataSource) {
  activeSource = source;
  listeners.forEach((listener) => listener());
}

/**
 * Point the remote dashboard at a farm, or at none (`reason` says why, for the
 * banner). On FarmNet the source is fixed to the Pi's farm.
 */
export function selectFarm(farmId: string | null, reason = "No farm selected.") {
  if (ON_FARMNET) return;
  setFarmDataSource(farmId ? createDashboardApiSource(farmId) : noFarmSource({ state: "offline", reason }));
}

export function onFarmDataSourceChange(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
