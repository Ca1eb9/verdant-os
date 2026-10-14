import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AlertSeverity, type FarmAlert } from "@farm/shared";
import { emailConfigFromEnv, sendAlertEmail } from "../src/email.js";

const config = { apiKey: "re_test", from: "Farm <alerts@example.com>", to: ["a@example.com", "b@example.com"] };

const alert: FarmAlert = {
  alert_id: "a1",
  severity: AlertSeverity.CRITICAL,
  source: "shelf-1",
  source_type: "shelf",
  message: "shelf-1 pH 4.9 is below the critical limit of 5.2",
  metric: "ph",
  value: 4.9,
  threshold: 5.2,
  timestamp: 0,
};

describe("emailConfigFromEnv", () => {
  it("is off when nothing is set", () => {
    assert.equal(emailConfigFromEnv({}), null);
  });

  it("splits the recipient list", () => {
    assert.deepEqual(emailConfigFromEnv({
      RESEND_API_KEY: "re_test",
      ALERT_EMAIL_FROM: "Farm <alerts@example.com>",
      ALERT_EMAIL_TO: " a@example.com, b@example.com ,",
    }), config);
  });

  it("is off, with a warning, when the setup is partial", () => {
    const warnings: string[] = [];
    assert.equal(emailConfigFromEnv({ RESEND_API_KEY: "re_test" }, (message) => warnings.push(message)), null);
    assert.deepEqual(warnings, ["email is off: ALERT_EMAIL_FROM, ALERT_EMAIL_TO not set"]);
  });
});

describe("sendAlertEmail", () => {
  it("posts the alert to Resend, keyed by alert_id", async () => {
    let request: { url: string; init: RequestInit } | undefined;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      request = { url, init };
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    assert.equal(await sendAlertEmail(config, alert, fakeFetch), true);
    assert.equal(request?.url, "https://api.resend.com/emails");
    const headers = request?.init.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer re_test");
    assert.equal(headers["Idempotency-Key"], "a1");
    const body = JSON.parse(request?.init.body as string);
    assert.deepEqual(body.to, config.to);
    assert.equal(body.subject, `[CRITICAL] ${alert.message}`);
  });

  it("reports failure without throwing", async () => {
    const refused = (async () => new Response("bad key", { status: 401 })) as typeof fetch;
    const offline = (async () => { throw new Error("getaddrinfo ENOTFOUND"); }) as typeof fetch;
    assert.equal(await sendAlertEmail(config, alert, refused), false);
    assert.equal(await sendAlertEmail(config, alert, offline), false);
  });
});
