// ============================================================
// State files — small JSON files a service keeps across restarts
// (and reboots), in /var/lib/verdant on the Pi.
// ============================================================

import { readFileSync, renameSync, writeFileSync } from "node:fs";

const lastWritten = new Map<string, string>();

/** The file's parsed JSON, or null on a first run or when it's unreadable (logged) */
export function readStateFile(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  try {
    const data: unknown = JSON.parse(raw);
    lastWritten.set(path, raw);
    return data;
  } catch {
    console.warn(`[STATE] Could not parse ${path}, starting empty`);
    return null;
  }
}

/** Writes only when it changed; temp file + rename so a crash can't truncate it. Never throws. */
export function writeStateFile(path: string, data: unknown) {
  const raw = JSON.stringify(data);
  if (raw === lastWritten.get(path)) return;
  try {
    writeFileSync(`${path}.tmp`, raw);
    renameSync(`${path}.tmp`, path);
    lastWritten.set(path, raw);
  } catch (err) {
    console.error(`[STATE] Could not write ${path}:`, err);
  }
}
