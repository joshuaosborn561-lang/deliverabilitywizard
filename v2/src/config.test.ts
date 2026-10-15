import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig, writesAllowed } from "./config.js";

function stop(decision: string, problem: string): string {
  return [
    "",
    "STOP — this reverses one of Josh's decisions.",
    `  Decision: ${decision}`,
    `  Problem:  ${problem}`,
    "Check with Josh before changing it. Do not delete this guard to go green.",
    "",
  ].join("\n");
}

const defaults = loadConfig({} as NodeJS.ProcessEnv);

describe("v2 config defaults", () => {
  it("D4: spend approval defaults to on", () => {
    assert.equal(defaults.requireSpendApproval, true, stop("D4", "spend approval defaulted off"));
  });

  it("D15: $25 domain / 25 mailbox monthly caps", () => {
    assert.equal(defaults.spendCapDomainUsd, 25);
    assert.equal(defaults.spendCapMailboxes, 25);
  });

  it("SHADOW is on and WRITE_ENABLED is off", () => {
    assert.equal(defaults.shadow, true);
    assert.equal(defaults.writeEnabled, false);
    assert.equal(writesAllowed(defaults), false);
  });

  it("WRITE_ENABLED alone is not enough", () => {
    const cfg = loadConfig({ WRITE_ENABLED: "true" } as NodeJS.ProcessEnv);
    assert.equal(cfg.writeEnabled, true);
    assert.equal(cfg.shadow, true);
    assert.equal(writesAllowed(cfg), false, "SHADOW still blocks");
  });

  it("writes only when WRITE_ENABLED=true and SHADOW=false", () => {
    const cfg = loadConfig({
      WRITE_ENABLED: "true",
      SHADOW: "false",
    } as NodeJS.ProcessEnv);
    assert.equal(writesAllowed(cfg), true);
  });

  it("D1/D50: warmup is 21 days", () => {
    assert.equal(defaults.poolWarmupDays, 21);
    assert.equal(defaults.campaignMinWarmupDays, 21);
    assert.equal(defaults.freshInboxWarmupDays, 21);
  });

  it("D5/D32: 80% same-ESP reading", () => {
    assert.equal(defaults.remediationInboxThreshold, 80);
    assert.equal(defaults.scoreSameEspOnly, true);
    assert.equal(defaults.bounceRateThreshold, 5);
  });

  it("D45: test quota unlimited", () => {
    assert.equal(defaults.totalTestQuota, 0);
  });

  it("D46: launch bar 85", () => {
    assert.equal(defaults.launchBar, 85);
  });

  it("D19: cleartechco.com is pre-warmed", () => {
    assert.ok(defaults.prewarmedDomains.includes("cleartechco.com"));
  });

  it("A8: 30-minute isolation deadline", () => {
    assert.equal(defaults.isolationDeadlineMs, 30 * 60 * 1000);
  });
});
