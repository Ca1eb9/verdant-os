import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ShelfPort } from "../src/config.js";
import { parseLine } from "../src/parse.js";

const shelf: ShelfPort = { shelf_id: "shelf-1", level: 0, port: "/dev/ttyACM0", ph_neutral_mv: 2000, ph_mv_per_unit: 286 };
const node = {
  seq: 3, temperature_c: 22, humidity_pct: 48, light_lux: 412, light_top_lux: 380,
  water_temp_c: 20.81, water_level_ok: true, ph_mv: 2000,
};
const parse = (line: object) => parseLine(JSON.stringify(line), shelf, 1000);

describe("parseLine", () => {
  it("publishes both light sensors' readings", () => {
    assert.deepEqual(parse(node), {
      seq: 3,
      data: {
        shelf_id: "shelf-1", level: 0, temperature_c: 22, humidity_pct: 48, light_lux: 412, light_top_lux: 380,
        water_temp_c: 20.81, water_level_ok: true, ph: 7, timestamp: 1000,
      },
    });
  });

  it("takes a light sensor that didn't read as null", () => {
    assert.equal(parse({ ...node, light_top_lux: null })?.data.light_top_lux, null);
  });

  it("takes lines from firmware without the top light sensor, its reading null", () => {
    const { light_top_lux: _, ...old } = node;
    assert.equal(parse(old)?.data.light_top_lux, null);
  });

  it("drops a line whose top light reading isn't a number", () => {
    assert.equal(parse({ ...node, light_top_lux: "380" }), null);
  });
});
