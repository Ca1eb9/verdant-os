// ============================================================
// Serial line → ShelfSensorData
//
// The node's line is untrusted until it matches the format in
// firmware/shelf-sensor/README.md. The node has no clock and no
// identity, so the shelf id, level and timestamp come from here.
// ============================================================

import type { ShelfSensorData } from "@farm/shared";
import type { ShelfPort } from "./config.js";

/** Outside the pH scale means the probe or board isn't connected */
const PH_MIN = 0;
const PH_MAX = 14;

export interface NodeReading {
  seq: number;
  data: ShelfSensorData;
}

type Obj = Record<string, unknown>;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const numOrNull = (v: unknown) => v === null || isNum(v);

export function phFromMv(mv: number, shelf: ShelfPort): number | null {
  const ph = 7 + (mv - shelf.ph_neutral_mv) / shelf.ph_mv_per_unit;
  if (ph < PH_MIN || ph > PH_MAX) return null;
  return Math.round(ph * 100) / 100;
}

/** Returns null for anything that isn't a valid reading line */
export function parseLine(line: string, shelf: ShelfPort, now: number): NodeReading | null {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Obj;
  if (
    !(Number.isInteger(o.seq) && (o.seq as number) >= 0) ||
    !numOrNull(o.temperature_c) ||
    !numOrNull(o.humidity_pct) ||
    !numOrNull(o.light_lux) ||
    !numOrNull(o.water_temp_c) ||
    !(o.water_level_ok === null || typeof o.water_level_ok === "boolean") ||
    !numOrNull(o.ph_mv)
  ) {
    return null;
  }

  return {
    seq: o.seq as number,
    data: {
      shelf_id: shelf.shelf_id,
      level: shelf.level,
      temperature_c: o.temperature_c as number | null,
      humidity_pct: o.humidity_pct as number | null,
      light_lux: o.light_lux as number | null,
      water_temp_c: o.water_temp_c as number | null,
      water_level_ok: o.water_level_ok as boolean | null,
      ph: o.ph_mv === null ? null : phFromMv(o.ph_mv as number, shelf),
      timestamp: now,
    },
  };
}
