import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ShelfPort } from "../src/config.js";
import { parseLine } from "../src/parse.js";

const shelf: ShelfPort = {
  shelf_id: "shelf-1", level: 0, port: "/dev/ttyACM0", ph_neutral_mv: 2000, ph_mv_per_unit: 286, light_levels: [0, 1],
};
const node = {
  seq: 3, temperature_c: 22, humidity_pct: 48, light_lux: [412, 380],
  water_temp_c: 20.81, water_level_ok: true, ph_mv: 2000,
};
const parse = (line: object, port = shelf) => parseLine(JSON.stringify(line), port, 1000);

describe("parseLine", () => {
  it("publishes each light sensor's reading with the level it faces", () => {
    assert.deepEqual(parse(node), {
      seq: 3,
      data: {
        shelf_id: "shelf-1", level: 0, temperature_c: 22, humidity_pct: 48,
        lights: [{ level: 0, lux: 412 }, { level: 1, lux: 380 }],
        water_temp_c: 20.81, water_level_ok: true, ph: 7, timestamp: 1000,
      },
    });
  });

  it("takes a light sensor that didn't read as null", () => {
    assert.deepEqual(parse({ ...node, light_lux: [null, 380] })?.data.lights, [{ level: 0, lux: null }, { level: 1, lux: 380 }]);
  });

  it("takes firmware with one light sensor, the other level null", () => {
    assert.deepEqual(parse({ ...node, light_lux: 412 })?.data.lights, [{ level: 0, lux: 412 }, { level: 1, lux: null }]);
  });

  it("drops a sensor the config gives no level", () => {
    assert.deepEqual(parse(node, { ...shelf, light_levels: [0] })?.data.lights, [{ level: 0, lux: 412 }]);
  });

  it("drops a line whose light readings aren't numbers", () => {
    assert.equal(parse({ ...node, light_lux: ["412", 380] }), null);
    assert.equal(parse({ ...node, light_lux: "412" }), null);
  });
});
