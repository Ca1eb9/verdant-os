import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.js";

const dir = mkdtempSync(join(tmpdir(), "shelf-bridge-"));
const base = {
  baud: 115200,
  reopen_interval_ms: 3000,
  silence_timeout_ms: 20000,
  watchdog_interval_ms: 5000,
  max_line_length: 512,
  shelves: [{ shelf_id: "shelf-1", level: 0, port: "/dev/ttyACM0", ph_neutral_mv: 2000, ph_mv_per_unit: 286 }],
};

function load(config: object) {
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(config));
  return loadConfig(path);
}

const lights = { shelf_id: "shelf-1", levels: [0, 1], robot_timeout_ms: 10000 };

describe("shelf bridge config", () => {
  it("takes the repo's config", () => {
    assert.ok(loadConfig(new URL("../../shelf-bridge-config.json", import.meta.url).pathname).lights);
  });

  it("runs without lights", () => {
    assert.equal(load(base).lights, undefined);
  });

  it("refuses lights on a shelf it doesn't have", () => {
    assert.throws(() => load({ ...base, lights: { ...lights, shelf_id: "shelf-2" } }), /shelf_id/);
  });

  it("refuses missing, repeated or fractional levels", () => {
    assert.throws(() => load({ ...base, lights: { ...lights, levels: [] } }), /levels/);
    assert.throws(() => load({ ...base, lights: { ...lights, levels: [1, 1] } }), /unique/);
    assert.throws(() => load({ ...base, lights: { ...lights, levels: [0.5] } }), /levels/);
  });

  it("refuses a missing robot timeout", () => {
    assert.throws(() => load({ ...base, lights: { ...lights, robot_timeout_ms: 0 } }), /robot_timeout_ms/);
  });
});
