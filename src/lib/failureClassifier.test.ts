import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyFailure } from "./failureClassifier.js";

describe("classifyFailure", () => {
  it("treats rate limits as non-remediable noise", () => {
    const c = classifyFailure("scan", "HTTP 429 Too Many Requests");
    assert.equal(c.class, "noise");
    assert.equal(c.autoRemediate, false);
  });

  it("treats sender-report rate limits as noise even when the test id contains 404", () => {
    // Production: test id 512404 made the old /404/ exclusion cancel noise
    // classification and launch the remediator (unknown:remediation:…rate-limit…).
    const c = classifyFailure(
      "remediation",
      "sender report 512404: Rate limit exceeded. Please try again later.",
    );
    assert.equal(c.class, "noise");
    assert.equal(c.autoRemediate, false);
    assert.equal(c.fingerprint, "noise:remediation");
  });

  it("still lets a real HTTP 404 cancel rate-limit-only noise classification", () => {
    // A message that is both rate-limit-shaped and a real missing endpoint
    // should not be collapsed to noise:rate-limit via the HTTP 429 branch.
    const c = classifyFailure(
      "monitor",
      "HTTP 404 rate limit exceeded on /api/v1/spam-test/12345",
    );
    // Falls through the noise gate because of \b404\b / not found-style paths;
    // classified as stale_endpoint (actionable).
    assert.equal(c.class, "stale_endpoint");
    assert.equal(c.autoRemediate, true);
  });

  it("treats bounce-stats request aborts / timeouts as noise", () => {
    for (const message of [
      "bounce stats: This operation was aborted",
      "bounce stats: request timed out after 60000ms",
      new DOMException("This operation was aborted", "AbortError"),
    ]) {
      const c = classifyFailure("remediation", message);
      assert.equal(c.class, "noise", String(message));
      assert.equal(c.autoRemediate, false, String(message));
      assert.equal(c.fingerprint, "noise:remediation");
    }
  });

  it("treats bounce-stats HTTP 524 / upstream 5xx as noise", () => {
    for (const message of [
      "bounce stats: HTTP 524",
      "bounce stats: HTTP 502",
      "health metrics: HTTP 503",
    ]) {
      const c = classifyFailure("remediation", message);
      assert.equal(c.class, "noise", message);
      assert.equal(c.autoRemediate, false, message);
      assert.equal(c.fingerprint, "noise:remediation");
    }
  });

  it("treats SURBL / unnamed blacklist as noise", () => {
    const c = classifyFailure(
      "domain-scan",
      "unnamed domain-blacklist hit (SURBL)",
    );
    assert.equal(c.class, "noise");
    assert.equal(c.autoRemediate, false);
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

  it("treats missing SmartDelivery spam tests as non-remediable noise", () => {
    const c = classifyFailure("monitor", "test 502070: Spam test not found");
    assert.equal(c.class, "noise");
    assert.equal(c.autoRemediate, false);
    assert.equal(c.fingerprint, "noise:missing-test");
  });

  it("still flags SmartDelivery endpoint-not-found as stale_endpoint", () => {
    const c = classifyFailure(
      "scan",
      "SmartDelivery endpoint not found — access may not be provisioned yet.",
    );
    assert.equal(c.class, "stale_endpoint");
    assert.equal(c.autoRemediate, true);
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

  it("does not auto-remediate SmartDelivery sequence-credit exhaustion", () => {
    const c = classifyFailure(
      "scan",
      "Failed creating tests for campaign 3763798: Insufficient sequence credits",
    );
    assert.equal(c.class, "auth_access");
    assert.equal(c.autoRemediate, false);
    assert.equal(c.fingerprint, "auth-access:sequence-credits");
    assert.match(c.summary, /sequence credits exhausted/i);
  });

  it("does not auto-remediate missing SmartDelivery seed accounts", () => {
    const c = classifyFailure(
      "scan",
      "Failed creating tests for campaign 3798227: No seed accounts found for the provided provider IDs",
    );
    assert.equal(c.class, "auth_access");
    assert.equal(c.autoRemediate, false);
    assert.equal(c.fingerprint, "auth-access:seed-providers");
    assert.match(c.summary, /no seed accounts/i);
  });

  it("treats denied/pending teardown approval as non-remediable noise", () => {
    const denied = classifyFailure(
      "remediation",
      "boldercyperpartnersys.info: teardown awaiting approval (denied) — see GET /approvals",
    );
    assert.equal(denied.class, "noise");
    assert.equal(denied.autoRemediate, false);
    assert.equal(denied.fingerprint, "noise:approval-gate");

    const pending = classifyFailure(
      "remediation",
      "otherdomain.info: teardown awaiting approval (pending) — see GET /approvals",
    );
    assert.equal(pending.class, "noise");
    assert.equal(pending.autoRemediate, false);
    assert.equal(pending.fingerprint, denied.fingerprint);

    const pool = classifyFailure(
      "pool",
      "Waiting on spend approval for 2 domain(s) — see GET /approvals",
    );
    assert.equal(pool.autoRemediate, false);
    assert.equal(pool.fingerprint, denied.fingerprint);
  });

  it("treats intentional unheld-retry summaries as non-remediable noise", () => {
    const c = classifyFailure(
      "remediation",
      "escob.breanna@crossscaleco.com: 1 campaign removal(s) failed — left unheld so the next run retries",
    );
    assert.equal(c.class, "noise");
    assert.equal(c.autoRemediate, false);
    assert.equal(c.fingerprint, "noise:retry-removal");
  });

  it("treats D41 burn-checklist refusal as non-remediable noise", () => {
    // Production fingerprints were collapsing per-domain to
    // unknown:remediation:remediation-…-burn-checklist and launching the
    // remediator after 2 hits.
    for (const domain of [
      "newvascowarranty.info",
      "trymeetconnect.info",
      "gogetintroduced.info",
      "vascowarrantynow.info",
    ]) {
      const c = classifyFailure(
        "remediation",
        `${domain}: burn checklist not ready (no corroborating same-ESP placement fail or bounce-over-threshold) — blacklist alone is not enough`,
      );
      assert.equal(c.class, "noise", domain);
      assert.equal(c.autoRemediate, false, domain);
      assert.equal(c.fingerprint, "noise:burn-checklist", domain);
      assert.match(c.summary, /burn checklist/i);
    }
    assert.notEqual(
      classifyFailure(
        "remediation",
        "newvascowarranty.info: burn checklist not ready (no corroborating same-ESP placement fail or bounce-over-threshold) — blacklist alone is not enough",
      ).fingerprint,
      "unknown:remediation:remediation-newvascowarranty-info-burn-checklist",
    );

    // Checklist reasons can say "non-SURBL" — must not fingerprint as noise:surbl.
    const nonSurblReason = classifyFailure(
      "remediation",
      "otherdomain.info: burn checklist not ready (no named (non-SURBL) blacklist hit) — blacklist alone is not enough",
    );
    assert.equal(nonSurblReason.fingerprint, "noise:burn-checklist");
    assert.equal(nonSurblReason.autoRemediate, false);
  });

  it("fingerprints unknown failures stably across numeric ids", () => {
    const a = classifyFailure("scan", "weird boom campaign 501701");
    const b = classifyFailure("scan", "weird boom campaign 999999");
    assert.equal(a.class, "unknown");
    assert.equal(a.autoRemediate, true);
    assert.equal(a.fingerprint, b.fingerprint);
  });
});
