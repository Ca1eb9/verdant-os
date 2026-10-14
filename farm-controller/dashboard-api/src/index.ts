// ============================================================
// Dashboard API
//
// Serves what the ingester stores (robot telemetry, alerts,
// operator commands) to the dashboard on FarmNet, read-only.
// Routes in server.ts.
//
// Run:  npx tsx src/index.ts
// ============================================================

import { createServer } from "http";
import Database from "better-sqlite3";

import { loadConfig, type ApiConfig } from "./config.js";
import { createHandler } from "./server.js";
import type { Db } from "./queries.js";

let config: ApiConfig;
try {
  config = loadConfig(process.env);
} catch (err) {
  console.error(`[FATAL] Bad dashboard API config: ${(err as Error).message}`);
  process.exit(1);
}

// Opened on first use and retried on each request until it works: the API can
// start before the ingester has created the database. Read-only, so it can
// never get in the ingester's way.
let db: Database.Database | null = null;
let openFailing = false;

function getDb(): Db | null {
  if (db) return db;
  try {
    db = new Database(config.dbPath, { readonly: true, fileMustExist: true });
    if (openFailing) console.log(`[API] Database available: ${config.dbPath}`);
    openFailing = false;
  } catch (err) {
    if (!openFailing) {
      console.warn(`[API] Can't open ${config.dbPath} yet (${(err as Error).message}), retrying on each request`);
    }
    openFailing = true;
  }
  return db;
}

const server = createServer(createHandler(config, getDb));

server.listen(config.port, () => {
  console.log(`[API] Dashboard API on port ${config.port}`);
  console.log(`[API]   database: ${config.dbPath}`);
  console.log(`[API]   CORS:     ${config.corsOrigins.join(", ")}`);
  getDb();
});

server.on("error", (err) => {
  console.error("[FATAL] Dashboard API failed:", err);
  process.exit(1);
});

const shutdown = () => {
  console.log("[API] Shutting down");
  server.close();
  db?.close();
  process.exit(0);
};
// systemd stops services with SIGTERM
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
