import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyFailure } from "./failureClassifier.js";

describe("classifyFailure", () => {
  it("treats rate limits as non-remediable noise", () => {
    const c = classifyFailure("scan", "HTTP 429 Too Many Requests");
    assert.equal(c.class, "noise");
    assert.equal(c.autoRemediate, false);
  });

  it("treats SURBL / unnamed blacklist as noise", () => {
    const c = classifyFailure(
      "domain-scan",
      "unnamed domain-blacklist hit (SURBL)",
    );
    assert.equal(c.class, "noise");
    assert.equal(c.autoRemediate, false);
  });

  it("does not auto-remediate pending or denied approval gates", () => {
    const denied = classifyFailure(
      "remediation",
      "boldercyperpartnersys.info: teardown awaiting approval (denied) — see GET /approvals",
    );
    assert.equal(denied.class, "noise");
    assert.equal(denied.autoRemediate, false);
    assert.equal(denied.fingerprint, "noise:spend-approval-gate");

    const pending = classifyFailure(
      "remediation",
      "example.info: teardown awaiting approval (pending) — see GET /approvals",
    );
    assert.equal(pending.autoRemediate, false);
    assert.equal(pending.fingerprint, denied.fingerprint);

    const pool = classifyFailure(
      "pool",
      "Waiting on spend approval for 2 domain(s) — see GET /approvals",
    );
    assert.equal(pool.autoRemediate, false);
    assert.equal(pool.fingerprint, denied.fingerprint);
  });

  it("flags SmartDelivery validation errors for auto-remediation", () => {
    const c = classifyFailure(
      "scan",
      "scheduler_cron_value must be of type object",
    );
    assert.equal(c.class, "api_validation");
    assert.equal(c.autoRemediate, true);
    assert.equal(c.fingerprint, "api-validation:scheduler-cron-value");
  });

  it("flags stale 404 endpoints", () => {
    const c = classifyFailure(
      "monitor",
      "HTTP 404 cannot GET /api/v1/analytics/campaign/12345/stats",
    );
    assert.equal(c.class, "stale_endpoint");
    assert.equal(c.autoRemediate, true);
    assert.equal(
      c.fingerprint,
      "stale-endpoint:api-v1-analytics-campaign-id-stats",
    );
  });

  it("flags TypeErrors", () => {
    const c = classifyFailure(
      "remediation",
      new TypeError("Cannot read properties of undefined (reading 'map')"),
    );
    assert.equal(c.class, "type_error");
    assert.equal(c.autoRemediate, true);
  });

  it("does not auto-remediate auth/access problems", () => {
    const c = classifyFailure(
      "scan",
      "SmartDelivery access: API access is not active",
    );
    assert.equal(c.class, "auth_access");
    assert.equal(c.autoRemediate, false);
  });

  it("fingerprints unknown failures stably across numeric ids", () => {
    const a = classifyFailure("scan", "weird boom campaign 501701");
    const b = classifyFailure("scan", "weird boom campaign 999999");
    assert.equal(a.class, "unknown");
    assert.equal(a.autoRemediate, true);
    assert.equal(a.fingerprint, b.fingerprint);
  });
});
