import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultReleasedCanaryEmails } from "../canon/constants.js";
import { isReleasedCanaryEmail } from "./fleet.js";
import {
  decideIsolationVerdict,
  filterFleetSenderRows,
  isolationOverdue,
  liveCampaignForTest,
  shouldQueueUglyScore,
} from "./isolation.js";
import { matchesAutoPlacementName } from "./names.js";

describe("isolation A8 on-ramp", () => {
  it("ignores released sender aminarodriguez@getcrosslaunchco.info", () => {
    assert.equal(
      isReleasedCanaryEmail("aminarodriguez@getcrosslaunchco.info"),
      true,
    );
    const { kept, releasedIgnored } = filterFleetSenderRows(
      [
        { email: "aminarodriguez@getcrosslaunchco.info", inbox: false, provider: "gmail" },
        { email: "living@canary.test", inbox: true, provider: "gmail" },
      ],
      ["living@canary.test"],
    );
    assert.equal(releasedIgnored, 1);
    assert.deepEqual(
      kept.map((r) => r.email),
      ["living@canary.test"],
    );
    assert.ok(defaultReleasedCanaryEmails().includes("aminarodriguez@getcrosslaunchco.info"));
  });

  it("matches warmed tests by Auto: name, not campaign_id", () => {
    assert.equal(
      matchesAutoPlacementName("Auto: SG MSP Engagers", "SG MSP Engagers"),
      true,
    );
    assert.equal(
      matchesAutoPlacementName("Auto: SG MSP Engagers (1/2)", "SG MSP Engagers"),
      true,
    );
    const mapped = liveCampaignForTest({
      testName: "Auto: BCP Logistics IT",
      campaigns: [
        { id: 3921852, name: "BCP Logistics IT", status: "ACTIVE", clientId: 1 },
      ],
    });
    assert.equal(mapped?.campaign.id, 3921852);
    assert.equal(mapped?.source, "live-placement");
  });

  it("maps Canary copy: #id to the live campaign", () => {
    const mapped = liveCampaignForTest({
      testName: "Canary copy: #3847940 SG MSP",
      campaigns: [
        { id: 3847940, name: "SG MSP", status: "ACTIVE", clientId: 1 },
      ],
    });
    assert.equal(mapped?.source, "canary-copy");
  });

  it("fresh 0% without a suspect is a queue, not a skip", () => {
    assert.equal(
      shouldQueueUglyScore({
        score: {
          campaignId: 1,
          source: "canary-copy",
          testId: "t",
          inboxPercent: 0,
          scoredAt: new Date().toISOString(),
          fleetEmailsScored: 2,
          releasedEmailsIgnored: 1,
        },
      }),
      true,
    );
    assert.equal(
      shouldQueueUglyScore({
        score: {
          campaignId: 1,
          source: "canary-copy",
          testId: "t",
          inboxPercent: 0,
          scoredAt: new Date().toISOString(),
          fleetEmailsScored: 2,
          releasedEmailsIgnored: 0,
        },
        suspect: {
          campaignId: 1,
          source: "canary-copy",
          queuedAt: new Date().toISOString(),
        },
      }),
      false,
    );
  });

  it("30-minute isolation deadline exists in code", () => {
    const first = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    assert.equal(isolationOverdue(first), true);
    const recent = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    assert.equal(isolationOverdue(recent), false);
  });

  it("COPY vs INFRA from unwarmed vs warmed", () => {
    const copy = decideIsolationVerdict({
      copyCanary: {
        unwarmedLanded: false,
        warmedLanded: false,
        unwarmedTested: 4,
        warmedTested: 4,
      },
      unwarmedCopyFineAcrossEsps: false,
    });
    assert.equal(copy.verdict, "COPY");
    const infra = decideIsolationVerdict({
      knownGoodFineAcrossEsps: false,
    });
    assert.equal(infra.verdict, "INFRA");
  });
});
