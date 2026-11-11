import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import { canonBoard } from "./canonCompliance.js";
import {
  DELIVERABILITY_TESTING_ENV,
  isDeliverabilityTestingEnabled,
  isTestingFinding,
  withoutTestingFindings,
} from "./deliverabilityTesting.js";

// D333 — this file exercises the default (off) state.
delete process.env[DELIVERABILITY_TESTING_ENV];

describe("D333 deliverability testing kill switch", () => {
  it("defaults to false; only the exact string \"true\" turns it on", () => {
    assert.equal(isDeliverabilityTestingEnabled({}), false);
    assert.equal(loadConfig({}).deliverabilityTestingEnabled, false);
    for (const value of ["", "1", "yes", "on", "TRUE", "True", " true", "false"]) {
      assert.equal(
        isDeliverabilityTestingEnabled({ [DELIVERABILITY_TESTING_ENV]: value }),
        false,
        `"${value}" must not enable testing`,
      );
      assert.equal(
        loadConfig({ [DELIVERABILITY_TESTING_ENV]: value }).deliverabilityTestingEnabled,
        false,
      );
    }
    assert.equal(
      isDeliverabilityTestingEnabled({ [DELIVERABILITY_TESTING_ENV]: "true" }),
      true,
    );
    assert.equal(
      loadConfig({ [DELIVERABILITY_TESTING_ENV]: "true" }).deliverabilityTestingEnabled,
      true,
    );
  });

  it("process default is off", () => {
    assert.equal(isDeliverabilityTestingEnabled(), false);
  });

  it("drops the testing findings when off and keeps every other kind", () => {
    const findings = [
      "no_placement_test: no recurring SmartDelivery test for serving inboxes",
      "missing_canary: campaign copy is not on the unwarmed senders canary",
      "inbox_missing_known_good: 3 serving inbox(es)",
      "below_launch_bar: 70% inbox",
      "understaffed: 12 of 40",
      "send_window: off canon",
    ];
    assert.deepEqual(withoutTestingFindings(findings), [
      "understaffed: 12 of 40",
      "send_window: off canon",
    ]);
    assert.deepEqual(
      withoutTestingFindings(findings, { [DELIVERABILITY_TESTING_ENV]: "true" }),
      findings,
    );
    assert.equal(isTestingFinding("missing_canary"), true);
    assert.equal(isTestingFinding("understaffed: x"), false);
  });

  it("stored no_placement_test / missing_canary rows never flip /health canonCompliant", () => {
    const board = canonBoard([
      {
        campaignId: 1,
        name: "Stale A",
        findings: [
          "no_placement_test: no recurring SmartDelivery test for serving inboxes",
          "missing_canary: campaign copy is not on the unwarmed senders canary",
        ],
      },
      { campaignId: 2, name: "Short B", findings: ["understaffed: 12 of 40"] },
    ] as never);
    assert.equal(board.campaigns[0]!.yes, true);
    assert.deepEqual(board.campaigns[0]!.fails, []);
    assert.equal(board.campaigns[1]!.yes, false, "other core holes still count");
    assert.deepEqual(board.campaigns[1]!.fails, ["understaffed"]);
  });
});
