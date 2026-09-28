import { readFileSync } from "fs";
import type { OrchestratorConfig } from "@farm/shared";

const DEFAULTS: OrchestratorConfig = {
  watchdog_interval_ms: 5000,
  heartbeat_timeout_ms: 30000,
  battery_low_pct: 20,
  battery_critical_pct: 15,
  charge_complete_pct: 95,
  max_task_retries: 2,
  task_retry_delay_ms: 60000,
  plant_schedules: [],
};

export function loadConfig(path?: string): OrchestratorConfig {
  if (!path) return { ...DEFAULTS };
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    return { ...DEFAULTS, ...raw };
  } catch (err) {
    console.warn(`[CONFIG] Could not load ${path}, using defaults`);
    return { ...DEFAULTS };
  }
}
