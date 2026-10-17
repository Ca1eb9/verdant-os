// ============================================================
// Task persistence — queued, assigned and finished tasks, and
// each robot's open problem alerts, are saved to a JSON file so
// a restart doesn't lose them. Robot state is not saved:
// telemetry rebuilds it.
// ============================================================

import { readFileSync, writeFileSync, renameSync } from "fs";
import type { FarmTask } from "@farm/shared";
import type { AlertProblem } from "./state-machine.js";

export interface PersistedTasks {
  queue: FarmTask[];
  assigned: FarmTask[];
  finished: FarmTask[];
  /** Per robot: the alert_id of each open problem, for its recovery alert to resolve */
  open_alerts: Record<string, Partial<Record<AlertProblem, string>>>;
}

const EMPTY: PersistedTasks = { queue: [], assigned: [], finished: [], open_alerts: {} };
const PROBLEMS: AlertProblem[] = ["lost", "error", "unknown_node"];

function parseOpenAlerts(value: unknown): PersistedTasks["open_alerts"] {
  const open: PersistedTasks["open_alerts"] = {};
  if (typeof value !== "object" || value === null) return open;
  for (const [robotId, alerts] of Object.entries(value)) {
    if (typeof alerts !== "object" || alerts === null) continue;
    for (const problem of PROBLEMS) {
      const alertId = (alerts as Record<string, unknown>)[problem];
      if (typeof alertId === "string" && alertId !== "") (open[robotId] ??= {})[problem] = alertId;
    }
  }
  return open;
}

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
      // Files from before open alerts were saved have none
      open_alerts: parseOpenAlerts(data.open_alerts),
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
