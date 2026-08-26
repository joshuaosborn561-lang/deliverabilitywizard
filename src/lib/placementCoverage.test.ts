import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  campaignsWithActiveAutos,
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

  it("D121: a living test id on another campaign does not cover this one", () => {
    const covered = testedCampaignCoverage(
      [
        {
          spam_test_id: "auto-20",
          campaign_id: 20,
          every_days: 1,
          status: "ACTIVE",
        },
      ],
      {
        "20": {
          campaignId: 20,
          campaignName: "ok",
          testedAt: "2026-08-01T00:00:00.000Z",
          testIds: ["auto-20"],
          mailboxCount: 10,
          testsCreated: 1,
        },
        "3847844": {
          campaignId: 3847844,
          campaignName: "Parlay Trendrr Ops",
          testedAt: "2026-08-26T06:00:00.000Z",
          testIds: ["auto-20"],
          mailboxCount: 20,
          testsCreated: 1,
        },
      },
    );
    assert.deepEqual([...covered].sort(), ["20"]);
  });

  it("D123: a living test with no campaign_id still covers the stored campaign", () => {
    const covered = testedCampaignCoverage(
      [
        {
          spam_test_id: "auto-41",
          every_days: 1,
          status: "ACTIVE",
        },
      ],
      {
        "3847841": {
          campaignId: 3847841,
          campaignName: "Parlay Receipts Sales",
          testedAt: "2026-08-26T07:00:00.000Z",
          testIds: ["auto-41"],
          mailboxCount: 20,
          testsCreated: 1,
        },
        "3847842": {
          campaignId: 3847842,
          campaignName: "sibling",
          testedAt: "2026-08-26T07:00:00.000Z",
          testIds: ["someone-else"],
          mailboxCount: 20,
          testsCreated: 1,
        },
      },
    );
    assert.deepEqual([...covered].sort(), ["3847841"]);
  });
});
