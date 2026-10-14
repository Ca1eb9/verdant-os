// ============================================================
// HTTP routes. Read-only: on FarmNet the dashboard sends commands
// straight over MQTT, so there is no command endpoint.
//
//   GET /health                          { ok, database }
//   GET /robots                          { robots: [newest telemetry per robot] }
//   GET /telemetry?robot_id=&from=&to=&limit=   { telemetry: [...] } oldest first
//   GET /alerts?severity=&source=&limit= { alerts: [...] } newest first
//   GET /commands?robot_id=              { commands: [...] } newest first, at most 10
//
// Times are milliseconds since 1970 (received_at, the Pi's clock).
// ============================================================

import type { IncomingMessage, ServerResponse } from "http";
import { AlertSeverity } from "@farm/shared";

import { LIMITS, type ApiConfig } from "./config.js";
import { latestRobots, recentAlerts, recentCommands, telemetryHistory, type Db } from "./queries.js";

/** The database, or null while it can't be opened (e.g. the ingester hasn't created it yet) */
export type DbProvider = () => Db | null;

class BadRequest extends Error {}

const SEVERITIES = new Set<string>(Object.values(AlertSeverity));

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function int(params: URLSearchParams, name: string, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const raw = params.get(name);
  if (raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new BadRequest(`${name} must be a whole number, 0 or more`);
  return Math.min(n, max);
}

function str(params: URLSearchParams, name: string): string | undefined {
  const v = params.get(name);
  return v ? v : undefined;
}

export function createHandler(config: ApiConfig, getDb: DbProvider, now: () => number = Date.now) {
  const allowed = new Set(config.corsOrigins);

  return (req: IncomingMessage, res: ServerResponse) => {
    const origin = req.headers.origin;
    if (origin && allowed.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "Access-Control-Allow-Methods": "GET", "Access-Control-Max-Age": "600" });
      res.end();
      return;
    }
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      send(res, 405, { error: "Only GET is supported" });
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    const q = url.searchParams;
    const db = getDb();

    if (url.pathname === "/health") {
      send(res, 200, { ok: true, database: db !== null });
      return;
    }
    const routes = ["/robots", "/telemetry", "/alerts", "/commands"];
    if (!routes.includes(url.pathname)) {
      send(res, 404, { error: `No route ${url.pathname}` });
      return;
    }
    if (!db) {
      send(res, 503, { error: "The telemetry database isn't available yet" });
      return;
    }

    try {
      switch (url.pathname) {
        case "/robots":
          send(res, 200, { robots: latestRobots(db) });
          return;
        case "/telemetry": {
          const to = int(q, "to", now());
          const from = int(q, "from", Math.max(0, to - LIMITS.telemetryWindowMs));
          if (from > to) throw new BadRequest("from must not be after to");
          const limit = int(q, "limit", LIMITS.telemetryDefault, LIMITS.telemetryMax);
          send(res, 200, { telemetry: telemetryHistory(db, { robotId: str(q, "robot_id"), from, to, limit }) });
          return;
        }
        case "/alerts": {
          const severity = str(q, "severity");
          if (severity && !SEVERITIES.has(severity)) {
            throw new BadRequest(`severity must be one of ${[...SEVERITIES].join(", ")}`);
          }
          const limit = int(q, "limit", LIMITS.alertsDefault, LIMITS.alertsMax);
          send(res, 200, {
            alerts: recentAlerts(db, { severity: severity as AlertSeverity | undefined, source: str(q, "source"), limit }),
          });
          return;
        }
        case "/commands":
          send(res, 200, { commands: recentCommands(db, str(q, "robot_id")) });
          return;
      }
    } catch (err) {
      if (err instanceof BadRequest) {
        send(res, 400, { error: err.message });
        return;
      }
      // e.g. a table the ingester hasn't created yet; never crash the service
      console.error(`[API] ${url.pathname} failed:`, err);
      send(res, 500, { error: "Query failed" });
    }
  };
}
