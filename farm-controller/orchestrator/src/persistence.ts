// ============================================================
// Task persistence — queued, assigned and finished tasks are
// saved to a JSON file so a restart doesn't lose them.
// Robot state is not saved: telemetry rebuilds it.
// ============================================================

import { readFileSync, writeFileSync, renameSync } from "fs";
import type { FarmTask } from "@farm/shared";

export interface PersistedTasks {
  queue: FarmTask[];
  assigned: FarmTask[];
  finished: FarmTask[];
}

const EMPTY: PersistedTasks = { queue: [], assigned: [], finished: [] };

let lastWritten = "";

export function loadTasks(path: string): PersistedTasks {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return EMPTY; // first run
  }
  try {
    const data = JSON.parse(raw);
    lastWritten = raw;
    return {
      queue: Array.isArray(data.queue) ? data.queue : [],
      assigned: Array.isArray(data.assigned) ? data.assigned : [],
      finished: Array.isArray(data.finished) ? data.finished : [],
    };
  } catch {
    console.warn(`[PERSIST] Could not parse ${path}, starting empty`);
    return EMPTY;
  }
}

/** Write only when something changed; temp file + rename so a crash can't truncate it */
export function saveTasks(path: string, tasks: PersistedTasks) {
  const data = JSON.stringify(tasks);
  if (data === lastWritten) return;
  try {
    writeFileSync(`${path}.tmp`, data);
    renameSync(`${path}.tmp`, path);
    lastWritten = data;
  } catch (err) {
    console.error(`[PERSIST] Could not write ${path}:`, err);
  }
}
