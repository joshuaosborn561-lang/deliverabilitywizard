import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { idleWindow, isIdleCampaign, sentCountOf } from "./campaignActivity.js";

describe("idleWindow", () => {
  it("is inclusive of both ends", () => {
    const w = idleWindow(7, new Date("2026-08-20T14:00:00Z"));
    assert.equal(w.startDate, "2026-08-14");
    assert.equal(w.endDate, "2026-08-20");
  });

  it("collapses to a single day at 1", () => {
    const w = idleWindow(1, new Date("2026-08-20T14:00:00Z"));
    assert.equal(w.startDate, "2026-08-20");
    assert.equal(w.endDate, "2026-08-20");
  });

  it("never produces an inverted window", () => {
    const w = idleWindow(0, new Date("2026-08-20T14:00:00Z"));
    assert.ok(w.startDate <= w.endDate);
  });
});

describe("sentCountOf", () => {
  it("reads numeric counts", () => {
    assert.equal(sentCountOf({ sent_count: 4279 }), 4279);
  });

  it("reads the string counts Smartlead sometimes returns", () => {
    assert.equal(sentCountOf({ sent_count: "4279" }), 4279);
  });

  it("treats missing/!finite counts as zero rather than throwing", () => {
    assert.equal(sentCountOf({}), 0);
    assert.equal(sentCountOf(null), 0);
    assert.equal(sentCountOf(undefined), 0);
    assert.equal(sentCountOf({ sent_count: "not-a-number" }), 0);
  });
});

describe("isIdleCampaign", () => {
  it("skips a campaign that sent nothing in the window", () => {
    // SalesGlider Trades Airpods, 2026-08-14..20: list fully worked.
    assert.equal(isIdleCampaign({ sent_count: 0 }, 7), true);
  });

  it("keeps a campaign that is still sending", () => {
    // Parlay2 over the same window.
    assert.equal(isIdleCampaign({ sent_count: 4279 }, 7), false);
  });

  it("keeps a campaign on the strength of a single send", () => {
    assert.equal(isIdleCampaign({ sent_count: 1 }, 7), false);
  });

  it("is disabled by a non-positive idleDays", () => {
    assert.equal(isIdleCampaign({ sent_count: 0 }, 0), false);
    assert.equal(isIdleCampaign({ sent_count: 0 }, -1), false);
    assert.equal(isIdleCampaign({ sent_count: 0 }, Number.NaN), false);
  });

  it("reads an absent count as idle — so callers must not pass a failed fetch", () => {
    // A missing sent_count is indistinguishable from zero here, which is why
    // the scanner catches analytics errors and skips the gate entirely rather
    // than handing the failure to this function. Locking the behaviour in so
    // that contract stays visible.
    assert.equal(isIdleCampaign({ sent_count: undefined }, 7), true);
    assert.equal(isIdleCampaign(null, 7), true);
  });
});
