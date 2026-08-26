import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  campaignSettingsWriteBody,
  desiredBounceAutopausePercent,
  isGoliathCampaign,
  isOver1kCampaign,
  isUnder1kCampaign,
  readBounceAutopausePercent,
} from "./bounceAutopause.js";

describe("desiredBounceAutopausePercent (D80)", () => {
  it("is always 100 — Smartlead autopause stays off", () => {
    assert.equal(desiredBounceAutopausePercent("BCP Healthcare Under-1k (No Team)"), 100);
    assert.equal(desiredBounceAutopausePercent("BCP Healthcare Over-1k (No Team)"), 100);
    assert.equal(desiredBounceAutopausePercent("Goliath Displacement L 501-1000"), 100);
    assert.equal(desiredBounceAutopausePercent("Vasco - Service - Nissan"), 100);
  });

  it("still recognises Under-1k / Over-1k names without using them to write", () => {
    assert.equal(isUnder1kCampaign("BCP Healthcare Under-1k (No Team)"), true);
    assert.equal(isOver1kCampaign("BCP Healthcare Over-1k (With Team)"), true);
    assert.equal(isUnder1kCampaign("Goliath Displacement L 501-1000"), false);
  });

  it("does not treat 501-1000 as Under-1k", () => {
    assert.equal(isUnder1kCampaign("Goliath Displacement L 501-1000"), false);
    assert.equal(isOver1kCampaign("BCP Healthcare Over-1k (With Team)"), true);
    assert.equal(isGoliathCampaign("Goliath Education Receipts - Large Public"), true);
  });
});

describe("readBounceAutopausePercent", () => {
  it("reads string, number, and wrapped payloads", () => {
    assert.equal(readBounceAutopausePercent({ bounce_autopause_threshold: "5" }), 5);
    assert.equal(readBounceAutopausePercent({ bounce_autopause_threshold: 20 }), 20);
    assert.equal(
      readBounceAutopausePercent({ data: { bounce_autopause_threshold: "7" } }),
      7,
    );
  });
});

describe("campaignSettingsWriteBody", () => {
  it("overlays the threshold and rewrites GET-only track flags", () => {
    const body = campaignSettingsWriteBody(
      {
        track_settings: ["DONT_EMAIL_OPEN", "DONT_LINK_CLICK"],
        stop_lead_settings: "REPLY_TO_AN_EMAIL",
        bounce_autopause_threshold: "5",
      },
      { bounce_autopause_threshold: "20" },
    );
    assert.deepEqual(body.track_settings, [
      "DONT_TRACK_EMAIL_OPEN",
      "DONT_TRACK_LINK_CLICK",
    ]);
    assert.equal(body.bounce_autopause_threshold, "20");
  });
});
