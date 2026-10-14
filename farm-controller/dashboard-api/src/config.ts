// Settings from the environment (/etc/verdant/dashboard-api.env on the Pi).

export interface ApiConfig {
  port: number;
  /** The ingester's SQLite database, opened read-only */
  dbPath: string;
  /** Browser origins allowed to call the API (the dashboard's addresses) */
  corsOrigins: string[];
}

// Response sizes. The dashboard's command history shows 10 (the same as its
// own /api/commands); the rest bound what one request can pull from the Pi.
export const LIMITS = {
  commands: 10,
  alertsDefault: 50,
  alertsMax: 500,
  telemetryDefault: 1000,
  telemetryMax: 10000,
  /** GET /telemetry with no `from`: this far back */
  telemetryWindowMs: 60 * 60 * 1000,
} as const;

/** Throws with the reason; the API can't run without a valid config */
export function loadConfig(env: NodeJS.ProcessEnv): ApiConfig {
  const port = Number(env.PORT ?? 3001);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PORT must be a port number, got "${env.PORT}"`);
  }
  const corsOrigins = (env.CORS_ORIGINS ?? "http://localhost:3000")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  return { port, dbPath: env.DB_PATH ?? "../ingester/farm_telemetry.db", corsOrigins };
}
