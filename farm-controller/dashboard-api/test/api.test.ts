import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import Database from "better-sqlite3";

import { loadConfig } from "../src/config.js";
import { createHandler } from "../src/server.js";

// The ingester's own CREATE statements, so the tests follow its schema
const ingester = readFileSync(new URL("../../ingester/src/index.ts", import.meta.url), "utf-8");
const schema = ingester.match(/db\.exec\(`(\s*CREATE TABLE IF NOT EXISTS robot_telemetry[\s\S]*?)`\);/)?.[1];
if (!schema) throw new Error("Couldn't find the schema in ingester/src/index.ts");

const NOW = 1_800_000_000_000;
const MIN = 60_000;

const db = new Database(":memory:");
db.exec(schema);

const tel = db.prepare(
  `INSERT INTO robot_telemetry (robot_id, status, current_node, task_id, last_completed_task_id,
     battery_pct, heading, obstacle_cm, temperature_c, timestamp, received_at)
   VALUES (?, ?, ?, NULL, NULL, ?, 90, NULL, ?, ?, ?)`,
);
// robot-01: a reading a minute for the last 2 hours; robot-02: three, long ago
for (let m = 120; m >= 0; m--) {
  tel.run("robot-01", "idle", `n${m}`, 100 - m / 10, m % 2 ? 21.5 : null, 5000 + m, NOW - m * MIN);
}
for (const m of [300, 299, 298]) tel.run("robot-02", "charging", "dock", 40, null, m, NOW - m * MIN);

const shelf = db.prepare(
  `INSERT INTO shelf_sensors (shelf_id, level, temperature_c, humidity_pct, light_lux, water_temp_c, water_level_ok, ph, timestamp, received_at)
   VALUES (?, 1, 22.5, NULL, 400, 19, ?, 6.1, ?, ?)`,
);
// shelf-1 every minute for 2 hours, water level ok / low / unknown in turn; shelf-2 once
for (let m = 120; m >= 0; m--) shelf.run("shelf-1", [1, 0, null][m % 3], NOW - m * MIN, NOW - m * MIN);
shelf.run("shelf-2", 1, NOW - 30 * MIN, NOW - 30 * MIN);

const alert = db.prepare(
  `INSERT INTO alerts (alert_id, severity, source, source_type, message, metric, value, threshold, timestamp, resolves, received_at)
   VALUES (?, ?, ?, 'robot', 'msg', 'battery_pct', 10, 15, 1, ?, ?)`,
);
alert.run("a1", "warning", "robot-01", null, NOW - 3 * MIN);
alert.run("a2", "critical", "robot-02", null, NOW - 2 * MIN);
alert.run("a3", "info", "robot-01", "a1", NOW - 1 * MIN);

const cmd = db.prepare(
  `INSERT INTO commands (id, robot_id, command, issued_by, issued_at, channel, received_at)
   VALUES (?, ?, ?, 'operator', ?, 'local', ?)`,
);
for (let i = 0; i < 12; i++) {
  cmd.run(`c${i}`, "robot-01", JSON.stringify({ command: "stop", priority: "critical", source: "local" }), i, NOW + i);
}
cmd.run("c-other", "robot-02", JSON.stringify({ command: "resume" }), 0, NOW + 50);
cmd.run("c-bad", "robot-01", "{not json", 0, NOW + 100);

const config = loadConfig({ PORT: "3001", CORS_ORIGINS: "http://farmnet.local:3000, http://localhost:3000" });
let dbAvailable = true;
let server: Server;
let base: string;

before(async () => {
  server = createServer(createHandler(config, () => (dbAvailable ? db : null), () => NOW));
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((r) => server.close(() => r())));

async function get(path: string, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, { headers });
  return { status: res.status, headers: res.headers, body: (await res.json()) as any };
}

describe("GET /robots", () => {
  it("returns each robot's newest row", async () => {
    const { status, body } = await get("/robots");
    assert.equal(status, 200);
    assert.deepEqual(body.robots.map((r: any) => [r.robot_id, r.current_node]), [
      ["robot-01", "n0"],
      ["robot-02", "dock"],
    ]);
    const r1 = body.robots[0];
    assert.equal(r1.received_at, NOW);
    assert.equal(r1.battery_pct, 100);
    assert.equal(r1.heading, 90);
    assert.equal(r1.obstacle_cm, null);
    assert.ok(!("temperature_c" in r1), "optional fields left out when NULL");
    assert.ok(!("id" in r1));
  });
});

describe("GET /telemetry", () => {
  it("defaults to the last hour, oldest first", async () => {
    const { body } = await get("/telemetry?robot_id=robot-01");
    assert.equal(body.telemetry.length, 61);
    assert.equal(body.telemetry[0].received_at, NOW - 60 * MIN);
    assert.equal(body.telemetry.at(-1).received_at, NOW);
    assert.equal(body.telemetry[1].temperature_c, 21.5);
  });
  it("takes a range and keeps the newest rows over the limit", async () => {
    const { body } = await get(`/telemetry?from=${NOW - 10 * MIN}&to=${NOW - 5 * MIN}&limit=3`);
    assert.deepEqual(body.telemetry.map((t: any) => t.received_at), [NOW - 7 * MIN, NOW - 6 * MIN, NOW - 5 * MIN]);
  });
  it("covers all robots without robot_id", async () => {
    const { body } = await get(`/telemetry?from=0`);
    assert.equal(body.telemetry.length, 124);
    assert.equal(body.telemetry[0].robot_id, "robot-02");
  });
  it("caps limit", async () => {
    const { status } = await get(`/telemetry?limit=999999`);
    assert.equal(status, 200);
  });
  for (const bad of ["from=abc", "limit=-1", "to=1.5", `from=${NOW}&to=${NOW - 1}`]) {
    it(`rejects ${bad}`, async () => {
      const { status, body } = await get(`/telemetry?${bad}`);
      assert.equal(status, 400);
      assert.ok(body.error);
    });
  }
});

describe("GET /shelves", () => {
  it("defaults to the last hour of one shelf, oldest first", async () => {
    const { status, body } = await get("/shelves?shelf_id=shelf-1");
    assert.equal(status, 200);
    assert.equal(body.readings.length, 61);
    assert.equal(body.readings[0].received_at, NOW - 60 * MIN);
    assert.deepEqual(body.readings.at(-1), {
      shelf_id: "shelf-1",
      level: 1,
      temperature_c: 22.5,
      humidity_pct: null,
      light_lux: 400,
      water_temp_c: 19,
      water_level_ok: true,
      ph: 6.1,
      timestamp: NOW,
      received_at: NOW,
    });
  });
  it("turns water_level_ok back into a boolean, null staying null", async () => {
    const { body } = await get(`/shelves?shelf_id=shelf-1&from=${NOW - 2 * MIN}`);
    assert.deepEqual(body.readings.map((r: any) => r.water_level_ok), [null, false, true]);
  });
  it("covers all shelves without shelf_id, with the same limit rules", async () => {
    const all = await get(`/shelves?from=${NOW - 31 * MIN}&to=${NOW - 29 * MIN}`);
    assert.deepEqual(all.body.readings.map((r: any) => r.shelf_id), ["shelf-1", "shelf-1", "shelf-2", "shelf-1"]);
    const limited = await get("/shelves?limit=2");
    assert.deepEqual(limited.body.readings.map((r: any) => r.received_at), [NOW - MIN, NOW]);
  });
  it("averages each shelf over bucket_ms, a low water level anywhere in a bucket showing", async () => {
    const { body } = await get(`/shelves?shelf_id=shelf-1&bucket_ms=${10 * MIN}`);
    // the last hour: six buckets of ten readings, and the newest on its own
    assert.equal(body.readings.length, 7);
    assert.deepEqual(body.readings.map((r: any) => r.received_at), [60, 50, 40, 30, 20, 10, 0].map((m) => NOW - m * MIN));
    assert.deepEqual(body.readings[0], {
      shelf_id: "shelf-1",
      level: 1,
      temperature_c: 22.5,
      humidity_pct: null,
      light_lux: 400,
      water_temp_c: 19,
      water_level_ok: false,
      ph: 6.1,
      timestamp: NOW - 51 * MIN,
      received_at: NOW - 60 * MIN,
    });
    assert.equal(body.readings.at(-1).water_level_ok, true);
  });
  it("buckets every shelf without shelf_id, newest `limit` buckets", async () => {
    const all = await get(`/shelves?from=${NOW - 35 * MIN}&to=${NOW - 25 * MIN}&bucket_ms=${10 * MIN}`);
    assert.deepEqual(all.body.readings.map((r: any) => r.shelf_id), ["shelf-1", "shelf-1", "shelf-2"]);  // the last two share a bucket
    const limited = await get(`/shelves?bucket_ms=${10 * MIN}&limit=2`);
    assert.deepEqual(limited.body.readings.map((r: any) => r.received_at), [NOW - 10 * MIN, NOW]);
  });
  for (const bad of ["limit=abc", `from=${NOW}&to=${NOW - 1}`, "bucket_ms=999", "bucket_ms=-5"]) {
    it(`rejects ${bad}`, async () => {
      assert.equal((await get(`/shelves?${bad}`)).status, 400);
    });
  }
});

describe("GET /alerts", () => {
  it("returns FarmAlerts newest first", async () => {
    const { body } = await get("/alerts");
    assert.deepEqual(body.alerts.map((a: any) => a.alert_id), ["a3", "a2", "a1"]);
    assert.deepEqual(Object.keys(body.alerts[0]).sort(), [
      "alert_id", "message", "metric", "resolves", "severity", "source", "source_type", "threshold", "timestamp", "value",
    ]);
    assert.equal(body.alerts[0].resolves, "a1");
    assert.equal(body.alerts[1].resolves, null);
  });
  it("filters by severity and source, with a limit", async () => {
    assert.deepEqual((await get("/alerts?severity=critical")).body.alerts.map((a: any) => a.alert_id), ["a2"]);
    assert.deepEqual((await get("/alerts?source=robot-01&limit=1")).body.alerts.map((a: any) => a.alert_id), ["a3"]);
  });
  it("rejects an unknown severity", async () => {
    assert.equal((await get("/alerts?severity=loud")).status, 400);
  });
});

describe("GET /commands", () => {
  it("returns the robot's last 10, newest first, skipping bad rows", async () => {
    const { body } = await get("/commands?robot_id=robot-01");
    assert.equal(body.commands.length, 10);
    assert.equal(body.commands[0].id, "c11");
    assert.deepEqual(body.commands[0], {
      id: "c11",
      robot_id: "robot-01",
      command: { command: "stop", priority: "critical", source: "local" },
      issued_by: "operator",
      issued_at: 11,
      status: "sent",
    });
  });
  it("covers all robots without robot_id", async () => {
    const { body } = await get("/commands");
    assert.equal(body.commands[0].id, "c-other");
  });
});

describe("HTTP", () => {
  it("allows the dashboard's origins only", async () => {
    const ok = await get("/health", { Origin: "http://farmnet.local:3000" });
    assert.equal(ok.headers.get("access-control-allow-origin"), "http://farmnet.local:3000");
    const no = await get("/health", { Origin: "http://evil.example" });
    assert.equal(no.headers.get("access-control-allow-origin"), null);
  });
  it("404s unknown routes and 405s other methods", async () => {
    assert.equal((await get("/nope")).status, 404);
    assert.equal((await fetch(base + "/commands", { method: "POST" })).status, 405);
  });
  it("503s until the database is there", async () => {
    dbAvailable = false;
    try {
      assert.deepEqual((await get("/health")).body, { ok: true, database: false });
      assert.equal((await get("/robots")).status, 503);
    } finally {
      dbAvailable = true;
    }
  });
});

describe("config", () => {
  it("rejects a bad port", () => {
    assert.throws(() => loadConfig({ PORT: "http" }));
  });
});
