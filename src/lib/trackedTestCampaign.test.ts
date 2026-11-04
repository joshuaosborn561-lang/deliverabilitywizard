import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { trackedTestCampaignIndex } from "./trackedTestCampaign.js";

const rec = (campaignId: number, testIds: string[]) => ({
  campaignId,
  campaignName: `C${campaignId}`,
  testedAt: "2026-11-04T21:13:00.000Z",
  testIds,
  mailboxCount: 50,
  testsCreated: testIds.length,
});

describe("trackedTestCampaignIndex (D326)", () => {
  it("maps each Wizard-created test id back to its campaign", () => {
    const index = trackedTestCampaignIndex({
      "4289735": rec(4289735, ["569168", "569169"]),
      "4290207": rec(4290207, ["569161"]),
    });
    assert.equal(index.get("569168"), 4289735);
    assert.equal(index.get("569169"), 4289735);
    assert.equal(index.get("569161"), 4290207);
    assert.equal(index.get("1"), undefined);
  });

  it("drops an id two campaigns both claim instead of guessing", () => {
    const index = trackedTestCampaignIndex({
      "1": rec(1, ["t1", "t2"]),
      "2": rec(2, ["t2"]),
      "3": rec(3, ["t2"]),
    });
    assert.equal(index.get("t1"), 1);
    assert.equal(index.has("t2"), false);
  });
});
