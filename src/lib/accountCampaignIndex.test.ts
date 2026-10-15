import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { indexAccountsByCampaign } from "./accountCampaignIndex.js";

describe("D271 account campaign index yields", () => {
  it("indexes memberships and lets the event loop tick", async () => {
    const accounts = Array.from({ length: 80 }, (_, i) => ({
      id: i + 1,
      from_email: `seat${i}@crosslaunchco.com`,
      campaign_ids: [10, 11, i + 100],
    }));
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 5);
    timer.unref?.();
    const byCampaign = await indexAccountsByCampaign(accounts);
    clearInterval(timer);
    assert.equal(byCampaign.get(10)?.length, 80);
    assert.equal(byCampaign.get(100)?.length, 1);
    assert.ok(ticks > 0, "indexAccountsByCampaign must yield");
  });
});
