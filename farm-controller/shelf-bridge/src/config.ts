import { readFileSync } from "fs";

export interface ShelfPort {
  shelf_id: string;
  level: number;
  /** Prefer /dev/serial/by-id/... so the path survives replugging */
  port: string;
  /** Board output (mV) with the probe in pH 7, or with the BNC shorted */
  ph_neutral_mv: number;
  /** mV change per pH unit; about +286 for the DFRobot pH meter V1.1 (voltage rises with pH) */
  ph_mv_per_unit: number;
  /**
   * Level each of the node's light sensors faces, in the node's order (its
   * light_lux values). Defaults to the shelf's own level: one sensor.
   */
  light_levels: number[];
}

/** The grow lights, switched by relays on one shelf's node (docs/shelf-sensors.md "Grow lights") */
export interface GrowLightsConfig {
  /** The shelf whose node has the relays */
  shelf_id: string;
  /** The level each relay channel switches, in channel order (the node's PIN_LIGHT_RELAY) */
  levels: number[];
  /**
   * Light each level only while a robot is on it (or riding the elevator to
   * it). Off or left out: every level is lit until all the robots are docked.
   */
  follow_robots?: boolean;
}

export interface ShelfBridgeConfig {
  baud: number;
  reopen_interval_ms: number;
  /** No line from a shelf for this long raises an alert */
  silence_timeout_ms: number;
  watchdog_interval_ms: number;
  /** Longer lines are dropped (noise, or a node not running shelf firmware) */
  max_line_length: number;
  shelves: ShelfPort[];
  /** Omitted: no grow light control */
  lights?: GrowLightsConfig;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isPos = (v: unknown) => isNum(v) && v > 0;

function isShelfPort(v: unknown): v is ShelfPort {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    isStr(s.shelf_id) &&
    Number.isInteger(s.level) &&
    isStr(s.port) &&
    isNum(s.ph_neutral_mv) &&
    isNum(s.ph_mv_per_unit) && s.ph_mv_per_unit !== 0
  );
}

/**
 * Relays on a shelf node (PIN_LIGHT_RELAY in firmware/shelf-sensor/src/config.h):
 * a longer lights line is refused by the node, which then keeps every light on
 */
const NODE_LIGHT_CHANNELS = 2;

/** Throws with the reason; the bridge can't run without a valid shelf list */
export function loadConfig(path: string): ShelfBridgeConfig {
  const c = JSON.parse(readFileSync(path, "utf-8"));
  for (const key of ["baud", "reopen_interval_ms", "silence_timeout_ms", "watchdog_interval_ms", "max_line_length"]) {
    if (!isPos(c[key])) throw new Error(`${key} must be a positive number`);
  }
  if (!Array.isArray(c.shelves) || c.shelves.length === 0) throw new Error("shelves must be a non-empty array");
  c.shelves.forEach((s: unknown, i: number) => {
    if (!isShelfPort(s)) throw new Error(`shelves[${i}] is missing or has an invalid field`);
    // A config from before light_levels: one light sensor, at the shelf's level
    s.light_levels ??= [s.level];
    const levels: unknown = s.light_levels;
    if (!Array.isArray(levels) || levels.length === 0 || !levels.every((n) => Number.isInteger(n))) {
      throw new Error(`shelves[${i}].light_levels must be a non-empty array of levels`);
    }
    if (new Set(levels).size !== levels.length) throw new Error(`shelves[${i}].light_levels values must be unique`);
  });
  const ids = c.shelves.map((s: ShelfPort) => s.shelf_id);
  const ports = c.shelves.map((s: ShelfPort) => s.port);
  if (new Set(ids).size !== ids.length) throw new Error("shelf_id values must be unique");
  if (new Set(ports).size !== ports.length) throw new Error("port values must be unique");
  if (c.lights !== undefined) checkLights(c.lights, ids);
  return c as ShelfBridgeConfig;
}

function checkLights(v: unknown, shelfIds: string[]) {
  if (typeof v !== "object" || v === null) throw new Error("lights must be an object");
  const l = v as Record<string, unknown>;
  if (!isStr(l.shelf_id) || !shelfIds.includes(l.shelf_id)) {
    throw new Error("lights.shelf_id must be one of the shelves");
  }
  if (!Array.isArray(l.levels) || l.levels.length === 0 || !l.levels.every((n) => Number.isInteger(n))) {
    throw new Error("lights.levels must be a non-empty array of levels");
  }
  if (new Set(l.levels).size !== l.levels.length) throw new Error("lights.levels values must be unique");
  if (l.levels.length > NODE_LIGHT_CHANNELS) {
    throw new Error(`lights.levels has ${l.levels.length} levels; the node has ${NODE_LIGHT_CHANNELS} relays`);
  }
  if (l.follow_robots !== undefined && typeof l.follow_robots !== "boolean") {
    throw new Error("lights.follow_robots must be true or false");
  }
}
