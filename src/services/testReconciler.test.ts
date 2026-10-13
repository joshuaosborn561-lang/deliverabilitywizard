import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reconcileCampaignLink } from "./testReconciler.js";

describe("reconcileCampaignLink", () => {
  it("judges a Canary copy test by the live campaign, not the paused shell", () => {
    assert.equal(
      reconcileCampaignLink({
        test_name: "Canary copy: #3954874 Cornerstone - B Nonprofit Role Inbox - Tickets",
        campaign_id: 3955156,
      }),
      "3954874",
    );
  });

  it("keeps a non-canary test on its own campaign id", () => {
    assert.equal(
      reconcileCampaignLink({
        test_name: "Cornerstone - B Nonprofit Role Inbox - Tickets",
        campaign_id: 3954874,
      }),
      "3954874",
    );
  });

  it("falls back to campaign_id when a Canary copy name has no live id", () => {
    assert.equal(
      reconcileCampaignLink({
        test_name: "Canary copy:",
        campaign_id: 3955156,
      }),
      "3955156",
    );
  });
});
