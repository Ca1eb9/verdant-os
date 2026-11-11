// ============================================================
// Grow lights
//
// Which of the grow lights (relay channels on one shelf node)
// should be on. Each is on unless the operator switched it off
// from the dashboard, or every robot is parked on the dock: a
// robot reaching the dock turns them off, and one leaving it
// turns them back on.
// ============================================================

import { type LightState, type LightSwitch, type LightsState, RobotStatus } from "@farm/shared";
import type { GrowLightsConfig } from "./config.js";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** A light switch from the dashboard; the light's index is checked against the config by setOperator */
export function isLightSwitch(v: unknown): v is LightSwitch {
  return isObj(v) && Number.isInteger(v.light) && typeof v.on === "boolean" &&
    isStr(v.issued_by) && typeof v.timestamp === "number" && Number.isFinite(v.timestamp);
}

export class GrowLights {
  /** Dock node ids, from the topology */
  private docks: Set<string> | null = null;
  /** Each robot's last report: whether it was parked on a dock */
  private parked = new Map<string, boolean>();
  /** The operator's switch per light, on until switched off (in memory: a restart turns them on) */
  private operatorOn: boolean[];

  constructor(private config: GrowLightsConfig) {
    this.operatorOn = config.channels.map(() => true);
  }

  /** The orchestrator's retained topology, for its dock nodes. False if it isn't a usable one. */
  setTopology(raw: unknown): boolean {
    if (!isObj(raw) || !Array.isArray(raw.nodes) || raw.nodes.length === 0 ||
        !raw.nodes.every((n) => isObj(n) && isStr(n.id) && isStr(n.type))) {
      return false;
    }
    this.docks = new Set((raw.nodes as Obj[]).filter((n) => n.type === "dock").map((n) => n.id as string));
    return true;
  }

  /**
   * A robot's telemetry. False if it isn't valid telemetry. A robot counts as
   * parked from its dock tag until it drives off (en_route from the dock turns
   * the lights on as it leaves). A robot that goes silent keeps its last place:
   * only reaching the dock turns the lights off.
   */
  onTelemetry(robotId: string, raw: unknown): boolean {
    if (!isObj(raw) || !isStr(raw.status) || !(raw.current_node === null || isStr(raw.current_node))) {
      return false;
    }
    const onDock = raw.current_node !== null && (this.docks?.has(raw.current_node) ?? false);
    this.parked.set(robotId, onDock && raw.status !== RobotStatus.EN_ROUTE);
    return true;
  }

  /** The operator's switch for one light. False if there's no such light. */
  setOperator(light: number, on: boolean): boolean {
    if (!Number.isInteger(light) || light < 0 || light >= this.operatorOn.length) return false;
    this.operatorOn[light] = on;
    return true;
  }

  /**
   * Every robot heard from is parked. None heard from (the bridge just
   * started, or no topology yet to know the dock): not docked, so the lights
   * stay on, as the node keeps them with no word from the Pi.
   */
  robotsDocked(): boolean {
    return this.parked.size > 0 && [...this.parked.values()].every(Boolean);
  }

  /** Each light's switch and whether it's lit, for the dashboard */
  state(timestamp: number): LightsState {
    const docked = this.robotsDocked();
    const lights: LightState[] = this.config.channels.map((name, i) => ({
      name,
      operator_on: this.operatorOn[i],
      on: this.operatorOn[i] && !docked,
    }));
    return { lights, robots_docked: docked, timestamp };
  }

  /** The line for the node: "lights " and one 1 (on) or 0 per light, in channel order */
  line(): string {
    return `lights ${this.state(0).lights.map((l) => (l.on ? "1" : "0")).join("")}`;
  }
}
