import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { campaignSettingsWriteBody } from "./bounceAutopause.js";

describe("campaignSettingsWriteBody", () => {
  it("echoes safe fields, rewrites GET-only track flags, applies the patch", () => {
    const body = campaignSettingsWriteBody(
      {
        track_settings: ["DONT_EMAIL_OPEN", "DONT_LINK_CLICK"],
        stop_lead_settings: "REPLY_TO_AN_EMAIL",
      },
      { min_time_btwn_emails: 10 },
    );
    assert.deepEqual(body.track_settings, [
      "DONT_TRACK_EMAIL_OPEN",
      "DONT_TRACK_LINK_CLICK",
    ]);
    assert.equal(body.stop_lead_settings, "REPLY_TO_AN_EMAIL");
    assert.equal(body.min_time_btwn_emails, 10);
  });

  it("D157: never echoes bounce_autopause_threshold — the handler discards it", () => {
    const body = campaignSettingsWriteBody(
      { bounce_autopause_threshold: "7", stop_lead_settings: "REPLY_TO_AN_EMAIL" },
      {},
    );
    assert.equal("bounce_autopause_threshold" in body, false);
  });
});
