import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  campaignSettingsWriteBody,
  loadBounceAutopauseSettings,
  readBounceAutopausePercent,
} from "./bounceAutopause.js";

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

describe("loadBounceAutopauseSettings (D80/D124)", () => {
  it("falls back to GET campaign when GET settings 404s or omits the threshold", async () => {
    const fromCampaign = await loadBounceAutopauseSettings(
      {
        getCampaignSettings: async () => {
          throw new Error("HTTP 404");
        },
        getCampaign: async () => ({ bounce_autopause_threshold: "5" }),
      },
      1,
    );
    assert.equal(readBounceAutopausePercent(fromCampaign), 5);

    const unread = await loadBounceAutopauseSettings(
      {
        getCampaignSettings: async () => {
          throw new Error("HTTP 404");
        },
        getCampaign: async () => {
          throw new Error("HTTP 404");
        },
      },
      2,
    );
    assert.equal(readBounceAutopausePercent(unread), null);
  });
});
