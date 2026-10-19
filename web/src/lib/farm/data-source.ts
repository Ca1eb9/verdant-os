// The seam between the farm UI and wherever farm data comes from.
//
// Two sources implement FarmDataSource: local-source.ts (MQTT over WebSocket
// to the Pi's broker, on the farm network) and remote-source.ts (Supabase,
// from anywhere). The UI only ever talks to this interface, so it works
// unchanged in both modes.
//
// A source serves one farm. On FarmNet that's the Pi's own farm; remotely,
// selectFarm() swaps in a source for the farm picked in the header.

import { createLocalSource } from "@/lib/farm/local-source";
import { createRemoteSource } from "@/lib/farm/remote-source";
import type { RobotView } from "@/lib/farm/robots";
import type { FarmAlert, FarmTopology, RobotCommand, ShelfSensorData, ThresholdLimits } from "@/lib/farm/types";

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
  /** Without the shelf's level remotely: Supabase doesn't keep it */
  data: Omit<ShelfSensorData, "level">;
  /** Browser receive time (Supabase's created_at for one loaded from it): there's no clock sync with the Pi */
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
  /**
   * Streams the farm's shelf readings, oldest first: those stored from before
   * the dashboard opened (where the source has them, possibly as means over
   * a few minutes), then every one received since. Again whenever one
   * arrives; null when this source has no live shelf feed. Returns unsubscribe.
   */
  subscribeShelfHistory(onHistory: (readings: ShelfReading[] | null) => void): () => void;
  /**
   * Streams the alert engine's limits per metric, as it publishes them; null
   * until they're known, or when this source has none. Returns unsubscribe.
   */
  subscribeThresholds(onThresholds: (thresholds: ThresholdLimits[] | null) => void): () => void;
}

export class CommandError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** A JSON response's body, or throws a CommandError with its error */
export async function readJson<T>(response: Response): Promise<T> {
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
    subscribeShelfHistory(onHistory) {
      onHistory(null);
      return () => undefined;
    },
    subscribeThresholds(onThresholds) {
      onThresholds(null);
      return () => undefined;
    },
  };
}

/** Mosquitto's WebSocket listener on the Pi (docs/WIFI-SETUP.md) */
const BROKER_WS_PORT = 9001;

/**
 * True when this page was served by a farm's Pi, which serves plain http on
 * the farm network; Vercel serves only https, where the browser would refuse
 * the broker's ws:// anyway. The broker is then on the page's own host.
 * Browser only: the server can't tell how the page was opened.
 */
export function isFarmNet() {
  return typeof window !== "undefined" && window.location.protocol === "http:";
}

// Until the FarmProvider has detected where the page runs (after hydration,
// so the server's render and the browser's first one match)
let activeSource: FarmDataSource = noFarmSource({ state: "connecting", reason: "Loading farms…" });
const listeners = new Set<() => void>();

export function getFarmDataSource() {
  return activeSource;
}

/** Swap in another data source */
export function setFarmDataSource(source: FarmDataSource) {
  activeSource = source;
  listeners.forEach((listener) => listener());
}

/**
 * Point the dashboard at a farm, or at none (`reason` says why, for the
 * banner). On FarmNet the source is the Pi's broker whatever the farm, once.
 */
export function selectFarm(farmId: string | null, reason = "No farm selected.") {
  if (isFarmNet()) {
    if (activeSource.mode !== "local") {
      const { hostname } = window.location;
      setFarmDataSource(createLocalSource(`ws://${hostname}:${BROKER_WS_PORT}`, process.env.NEXT_PUBLIC_DASHBOARD_API_URL));
    }
    return;
  }
  setFarmDataSource(farmId ? createRemoteSource(farmId) : noFarmSource({ state: "offline", reason }));
}

export function onFarmDataSourceChange(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
