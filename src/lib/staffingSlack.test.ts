import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { slackJargonHits } from "./slackPlainEnglish.js";
import {
  staffingShortAlertKey,
  staffingSlackLines,
} from "./staffingSlack.js";

describe("staffingSlackLines", () => {
  it("does not blame a generic shortage (D63)", () => {
    const text = staffingSlackLines({
      stillShort: [
        {
          name: "BCP PE Firms (No Team)",
          staffable: 22,
          shortBy: 22,
          status: "ACTIVE",
        },
      ],
    }).join("\n");
    assert.match(text, /Spare inboxes are not the shortage/);
    assert.doesNotMatch(text, /not enough warmed spares/i);
    assert.doesNotMatch(text, /not enough.*generic/i);
    assert.deepEqual(slackJargonHits(text), []);
  });

  it("end-of-day copy stays plain English", () => {
    const text = [
      "Staffing (end of day)",
      "Spare inboxes are not the shortage. They stay on Goliath.",
      "These campaigns are missing this client's own inboxes that should be sending this week:",
      "• BCP PE Firms — 22 sending, 22 of this client's inboxes that should be on are not.",
    ].join("\n");
    assert.deepEqual(slackJargonHits(text), []);
  });

  it("stable-keys the same short set", () => {
    assert.equal(
      staffingShortAlertKey([
        { campaignId: 2, shortBy: 8 },
        { campaignId: 1, shortBy: 22 },
      ]),
      staffingShortAlertKey([
        { campaignId: 1, shortBy: 22 },
        { campaignId: 2, shortBy: 8 },
      ]),
    );
  });
});
