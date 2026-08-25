import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  campaignSettingsWriteBody,
  desiredBounceAutopausePercent,
  isUnder1kCampaign,
  readBounceAutopausePercent,
} from "./bounceAutopause.js";

describe("isUnder1kCampaign", () => {
  it("matches BCP Under-1k names", () => {
    assert.equal(isUnder1kCampaign("BCP Healthcare Under-1k (No Team)"), true);
    assert.equal(isUnder1kCampaign("BCP Healthcare Under-1k (With Team)"), true);
    assert.equal(isUnder1kCampaign("BCP Logistics Under 1k (No Team)"), true);
    assert.equal(isUnder1kCampaign("bcp logistics under1k (with team)"), true);
  });

  it("does not match Over-1k or Goliath band names", () => {
    assert.equal(isUnder1kCampaign("BCP Healthcare Over-1k (No Team)"), false);
    assert.equal(isUnder1kCampaign("BCP Logistics Over-1k (With Team)"), false);
    assert.equal(isUnder1kCampaign("Goliath Displacement L 501-1000"), false);
    assert.equal(isUnder1kCampaign("Goliath Education 50-200"), false);
    assert.equal(isUnder1kCampaign("Parlay 201-500"), false);
  });
});

describe("desiredBounceAutopausePercent", () => {
  it("returns 20 for Under-1k and null for everyone else", () => {
    assert.equal(
      desiredBounceAutopausePercent("BCP Healthcare Under-1k (No Team)", 20),
      20,
    );
    assert.equal(
      desiredBounceAutopausePercent("BCP Healthcare Over-1k (No Team)", 20),
      null,
    );
    assert.equal(desiredBounceAutopausePercent("Goliath 501-1000", 20), null);
  });
});

describe("readBounceAutopausePercent", () => {
  it("reads string, number, and wrapped payloads", () => {
    assert.equal(readBounceAutopausePercent({ bounce_autopause_threshold: "7" }), 7);
    assert.equal(readBounceAutopausePercent({ bounce_autopause_threshold: 20 }), 20);
    assert.equal(
      readBounceAutopausePercent({ data: { bounce_autopause_threshold: "20" } }),
      20,
    );
    assert.equal(readBounceAutopausePercent({}), null);
  });
});

describe("campaignSettingsWriteBody", () => {
  it("overlays the threshold and rewrites GET-only track flags", () => {
    const body = campaignSettingsWriteBody(
      {
        track_settings: ["DONT_EMAIL_OPEN", "DONT_LINK_CLICK"],
        stop_lead_settings: "REPLY_TO_AN_EMAIL",
        ignoreOOOasReply: true,
        client_id: 542838,
        bounce_autopause_threshold: "7",
      },
      { bounce_autopause_threshold: "20" },
    );
    assert.deepEqual(body.track_settings, [
      "DONT_TRACK_EMAIL_OPEN",
      "DONT_TRACK_LINK_CLICK",
    ]);
    assert.equal(body.stop_lead_settings, "REPLY_TO_AN_EMAIL");
    assert.equal(body.ignoreOOOasReply, true);
    assert.equal(body.bounce_autopause_threshold, "20");
    assert.equal("client_id" in body, false);
  });

  it("posts only the patch when GET is empty", () => {
    assert.deepEqual(campaignSettingsWriteBody(null, { bounce_autopause_threshold: "20" }), {
      bounce_autopause_threshold: "20",
    });
  });
});
