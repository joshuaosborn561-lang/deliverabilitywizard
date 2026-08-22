import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isBenignOpsNoise, isBurnChecklistNoise } from "../lib/alertNoise.js";
import { classifyFailure } from "../lib/failureClassifier.js";

/**
 * Production fingerprint that launched this remediator:
 * unknown:remediation:remediation-winvascowarranty-info-burn-checklist
 *
 * Classifier noise (#69) stops relaunches; remediation must also stop
 * pushing the D41 skip into result.errors every cron.
 */
const PRODUCTION_ERROR =
  "winvascowarranty.info: burn checklist not ready (no corroborating same-ESP placement fail or bounce-over-threshold) — blacklist alone is not enough";

describe("burn checklist refuse is not a bug", () => {
  it("keeps the production fingerprint non-auto-remediable", () => {
    const classified = classifyFailure("remediation", PRODUCTION_ERROR);
    assert.equal(classified.autoRemediate, false);
    assert.equal(classified.class, "noise");
    assert.equal(classified.fingerprint, "noise:burn-checklist");
  });

  it("skips Slack paging for the same string", () => {
    assert.equal(isBurnChecklistNoise(PRODUCTION_ERROR), true);
    assert.equal(isBenignOpsNoise(PRODUCTION_ERROR), true);
  });
});
