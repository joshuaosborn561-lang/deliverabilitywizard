import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  campaignsWithActiveAutos,
  countTestsAgainstQuota,
  testedCampaignCoverage,
} from "./placementCoverage.js";

describe("placementCoverage", () => {
  it("only counts stoppable automated tests as coverage", () => {
    const covered = campaignsWithActiveAutos([
      {
        spam_test_id: 1,
        campaign_id: 10,
        every_days: 1,
        status: "ACTIVE",
      },
      {
        spam_test_id: 2,
        campaign_id: 11,
        every_days: 1,
        status: "COMPLETED",
      },
      {
        spam_test_id: 3,
        campaign_id: 12,
        test_type: "manual",
        status: "ACTIVE",
      },
    ]);
    assert.deepEqual([...covered].sort(), ["10"]);
  });

  it("ignores stale state marks that point at completed manuals", () => {
    const covered = testedCampaignCoverage(
      [
        {
          spam_test_id: "auto-1",
          campaign_id: 20,
          every_days: 1,
          status: "ACTIVE",
        },
        {
          spam_test_id: "old-manual",
          campaign_id: 21,
          test_type: "manual",
          status: "COMPLETED",
        },
      ],
      {
        "20": {
          campaignId: 20,
          campaignName: "ok",
          testedAt: "2026-08-01T00:00:00.000Z",
          testIds: ["auto-1"],
          mailboxCount: 10,
          testsCreated: 1,
        },
        "21": {
          campaignId: 21,
          campaignName: "stale",
          testedAt: "2026-07-01T00:00:00.000Z",
          testIds: ["old-manual"],
          mailboxCount: 10,
          testsCreated: 1,
        },
        "22": {
          campaignId: 22,
          campaignName: "state-only-stale",
          testedAt: "2026-07-01T00:00:00.000Z",
          testIds: ["gone"],
          mailboxCount: 10,
          testsCreated: 1,
        },
      },
    );
    assert.deepEqual([...covered].sort(), ["20"]);
  });

  it("counts only living tests against the concurrent quota", () => {
    assert.equal(
      countTestsAgainstQuota([
        { spam_test_id: 1, status: "ACTIVE", every_days: 1 },
        { spam_test_id: 2, status: "SCHEDULED", every_days: 1 },
        { spam_test_id: 3, status: "STOPPED", every_days: 1 },
        { spam_test_id: 4, status: "COMPLETED", test_type: "manual" },
        { spam_test_id: 5, status: "IN_PROGRESS" },
      ]),
      3,
    );
  });
});
