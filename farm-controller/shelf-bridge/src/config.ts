import { readFileSync } from "fs";

export interface ShelfPort {
  shelf_id: string;
  level: number;
  /** Prefer /dev/serial/by-id/... so the path survives replugging */
  port: string;
  /** Board output (mV) with the probe in pH 7, or with the BNC shorted */
  ph_neutral_mv: number;
  /** mV change per pH unit; negative for the PH-4502C (voltage falls as pH rises) */
  ph_mv_per_unit: number;
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

/** Throws with the reason; the bridge can't run without a valid shelf list */
export function loadConfig(path: string): ShelfBridgeConfig {
  const c = JSON.parse(readFileSync(path, "utf-8"));
  for (const key of ["baud", "reopen_interval_ms", "silence_timeout_ms", "watchdog_interval_ms", "max_line_length"]) {
    if (!isPos(c[key])) throw new Error(`${key} must be a positive number`);
  }
  if (!Array.isArray(c.shelves) || c.shelves.length === 0) throw new Error("shelves must be a non-empty array");
  c.shelves.forEach((s: unknown, i: number) => {
    if (!isShelfPort(s)) throw new Error(`shelves[${i}] is missing or has an invalid field`);
  });
  const ids = c.shelves.map((s: ShelfPort) => s.shelf_id);
  const ports = c.shelves.map((s: ShelfPort) => s.port);
  if (new Set(ids).size !== ids.length) throw new Error("shelf_id values must be unique");
  if (new Set(ports).size !== ports.length) throw new Error("port values must be unique");
  return c as ShelfBridgeConfig;
}
