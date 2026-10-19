import { readFileSync } from "fs";

// Secrets and the farm id come from the environment
// (/etc/verdant/supabase-bridge.env on the Pi); tunable values from
// farm-controller/supabase-bridge-config.json.

export interface BridgeEnv {
  brokerUrl: string;
  supabaseUrl: string;
  /** The secret (service_role) key: it bypasses RLS, so it never leaves the Pi */
  serviceKey: string;
  /** This farm's row in the farms table, stamped on every row the bridge writes */
  farmId: string;
}

export interface BridgeConfig {
  /** Wait between attempts to reach Supabase */
  retry_interval_ms: number;
  /** A remote command still pending after this long (Supabase's clock) fails as stale instead of being sent */
  stale_command_ms: number;
  /** Longest wait for Supabase when stopping; with no internet it would never answer */
  shutdown_timeout_ms: number;
  /** At most one telemetry row per robot, and one reading per shelf, this often (a robot's status or node change goes at once) */
  sample_interval_ms: number;
  /** How often buffered rows go to Supabase */
  flush_interval_ms: number;
  /** Rows per request */
  max_batch_rows: number;
  /** Rows kept while Supabase is unreachable; beyond it the oldest telemetry and readings are dropped */
  max_buffer_rows: number;
  /** How often the rows sent are logged */
  stats_interval_ms: number;
}

/** Same rule as farms.id in web/supabase/farms.sql */
const FARM_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Throws with the reason; the bridge can't run without these */
export function loadEnv(env: NodeJS.ProcessEnv): BridgeEnv {
  const supabaseUrl = env.SUPABASE_URL?.trim();
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const farmId = env.FARM_ID?.trim();

  if (!supabaseUrl) throw new Error("SUPABASE_URL is not set");
  try {
    new URL(supabaseUrl);
  } catch {
    throw new Error(`SUPABASE_URL is not a URL: "${supabaseUrl}"`);
  }
  if (!serviceKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  // The publishable key can read but never write, so every write would fail later
  if (serviceKey.startsWith("sb_publishable_")) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY holds the publishable key; the bridge needs the secret key");
  }
  if (!farmId) throw new Error("FARM_ID is not set");
  if (!FARM_ID_PATTERN.test(farmId)) {
    throw new Error(`FARM_ID must be lowercase letters, digits and dashes, got "${farmId}"`);
  }

  return { brokerUrl: env.BROKER_URL ?? "mqtt://localhost:1883", supabaseUrl, serviceKey, farmId };
}

const isPos = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0;

/** Throws with the reason */
export function loadConfig(path: string): BridgeConfig {
  const c = JSON.parse(readFileSync(path, "utf-8"));
  for (const key of [
    "retry_interval_ms", "stale_command_ms", "shutdown_timeout_ms", "sample_interval_ms",
    "flush_interval_ms", "max_batch_rows", "max_buffer_rows", "stats_interval_ms",
  ]) {
    if (!isPos(c[key])) throw new Error(`${key} must be a positive number`);
  }
  return c as BridgeConfig;
}
