import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyRunoutPerformance,
  consumedPercent,
  formatRunoutMessage,
  parseCampaignLeadStats,
  runoutStage,
} from "./leadRunout.js";

describe("lead runout", () => {
  it("reads total/contacted and campaign_lead_stats remaining", () => {
    const fromTotals = parseCampaignLeadStats({
      data: { total_leads: 1000, contacted: 500, replied: 20, reply_rate: 4 },
    });
    assert.equal(fromTotals?.remaining, 500);
    assert.equal(consumedPercent(fromTotals!), 50);
    assert.equal(runoutStage(50), "half");

    const fromLeadStats = parseCampaignLeadStats({
      campaign_lead_stats: { total: 800, notStarted: 200, interested: 6 },
      contacted: 600,
    });
    assert.equal(fromLeadStats?.remaining, 200);
    assert.equal(fromLeadStats?.positiveReplies, 6);
    assert.equal(runoutStage(consumedPercent(fromLeadStats!)), "three_quarters");
  });

  it("marks done at the end of the list", () => {
    const stats = parseCampaignLeadStats({
      total_leads: 400,
      contacted: 400,
      replied: 2,
    });
    assert.equal(stats?.remaining, 0);
    assert.equal(runoutStage(100), "done");
  });

  it("treats replies as working and silence after a sample as struggling", () => {
    assert.equal(
      classifyRunoutPerformance({
        total: 1000,
        contacted: 200,
        remaining: 800,
        replied: 8,
        positiveReplies: 2,
        replyRate: 4,
      }),
      "working",
    );
    assert.equal(
      classifyRunoutPerformance({
        total: 1000,
        contacted: 200,
        remaining: 200,
        replied: 0,
        positiveReplies: 0,
        replyRate: 0.1,
      }),
      "struggling",
    );
    assert.equal(
      classifyRunoutPerformance({
        total: 40,
        contacted: 20,
        remaining: 20,
        replied: 0,
        positiveReplies: 0,
        replyRate: 0,
      }),
      "unknown",
    );
  });

  it("says start sourcing at half and do not top up a dead campaign", () => {
    const working = formatRunoutMessage({
      campaignName: "Parlay A",
      stage: "three_quarters",
      remaining: 400,
      sentPerDay: 200,
      performance: "working",
    });
    assert.match(working, /three quarters/);
    assert.match(working, /400/);
    assert.match(working, /200/);
    assert.match(working, /about 2 days/);
    assert.match(working, /next batch in hand/);
    assert.match(working, /have not imported/);
    assert.doesNotMatch(working, /D\d+/);

    const dead = formatRunoutMessage({
      campaignName: "Quiet",
      stage: "half",
      remaining: 500,
      sentPerDay: 100,
      performance: "struggling",
    });
    assert.match(dead, /Do not top it up/);
    assert.match(dead, /have not imported/);
  });
});
