import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadEnv } from "../src/config.js";

const jwt = (payload: object) =>
  `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;

const env = (key: string) => ({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: key, FARM_ID: "atlas" });

describe("bridge settings", () => {
  it("accepts a secret key or the legacy service_role key", () => {
    assert.equal(loadEnv(env("sb_secret_abc")).serviceKey, "sb_secret_abc");
    assert.equal(loadEnv(env(jwt({ role: "service_role" }))).farmId, "atlas");
  });

  it("refuses the publishable key and the legacy anon key", () => {
    assert.throws(() => loadEnv(env("sb_publishable_abc")), /publishable/);
    assert.throws(() => loadEnv(env(jwt({ role: "anon" }))), /anon key/);
  });

  it("refuses a farm id the farms table wouldn't take", () => {
    assert.throws(() => loadEnv({ ...env("sb_secret_abc"), FARM_ID: "Atlas Farm" }), /FARM_ID/);
  });
});
