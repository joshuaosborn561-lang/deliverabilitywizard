import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { indexAccountsByCampaign } from "./accountCampaignIndex.js";

describe("D271 account campaign index yields", () => {
  it("indexes memberships and lets the event loop tick", async () => {
    const accounts = Array.from({ length: 400 }, (_, i) => ({
      id: i + 1,
      from_email: `seat${i}@crosslaunchco.com`,
      campaign_ids: [10, 11, i + 100],
    }));
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 1);
    timer.unref?.();
    const byCampaign = await indexAccountsByCampaign(accounts);
    clearInterval(timer);
    assert.equal(byCampaign.get(10)?.length, 400);
    assert.equal(byCampaign.get(100)?.length, 1);
    assert.ok(ticks > 0, "indexAccountsByCampaign must yield");
  });

  it("D272: yields inside fat campaigns[] not only every 32 accounts", async () => {
    const accounts = Array.from({ length: 40 }, (_, i) => ({
      id: i + 1,
      from_email: `seat${i}@crosslaunchco.com`,
      campaigns: Array.from({ length: 120 }, (_, j) => ({ id: j + 1 })),
    }));
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 1);
    timer.unref?.();
    const byCampaign = await indexAccountsByCampaign(accounts);
    clearInterval(timer);
    assert.equal(byCampaign.get(1)?.length, 40);
    assert.equal(byCampaign.get(120)?.length, 40);
    assert.ok(ticks > 0, "inner campaign-id walk must yield");
  });

  it("D295: duplicate campaign_ids or duplicate account rows index once", async () => {
    const byCampaign = await indexAccountsByCampaign([
      {
        id: 18696498,
        from_email: "osbornjoshua@joshosales.info",
        campaign_ids: [4173509, 4173509],
      },
      {
        id: 18696498,
        from_email: "osbornjoshua@joshosales.info",
        campaign_ids: [4173509],
      },
    ]);
    assert.equal(byCampaign.get(4173509)?.length, 1);
  });
});
