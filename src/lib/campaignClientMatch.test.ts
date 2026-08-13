import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  brandToken,
  matchClientForCampaign,
} from "./campaignClientMatch.js";

describe("campaignClientMatch", () => {
  it("extracts a brand token from the campaign name", () => {
    assert.equal(brandToken("Goliath L3 Manufacturing"), "goliath");
    assert.equal(brandToken("Nieto Sports or Airpods Offer"), "nieto");
  });

  it("matches when the campaign name contains the client name", () => {
    const hit = matchClientForCampaign(
      { id: 1, name: "Randy Gaines PE Outreach", client_id: null },
      [{ id: 446286, name: "Randy Gaines" }],
      [],
    );
    assert.equal(hit?.clientId, 446286);
    assert.match(hit?.reason ?? "", /contains client/i);
  });

  it("falls back to a sibling campaign with the same brand", () => {
    const hit = matchClientForCampaign(
      { id: 2, name: "Goliath L4 New Vertical", client_id: null },
      [{ id: 548611, name: "Dave Ackley" }],
      [
        {
          id: 1,
          name: "Goliath L3 Manufacturing",
          client_id: 548611,
        },
      ],
    );
    assert.equal(hit?.clientId, 548611);
    assert.match(hit?.reason ?? "", /sibling/i);
  });

  it("returns null when nothing matches (e.g. orphaned Nieto)", () => {
    const hit = matchClientForCampaign(
      { id: 9, name: "Nieto Sports or Airpods Offer", client_id: null },
      [{ id: 548611, name: "Dave Ackley" }],
      [{ id: 1, name: "Goliath L3", client_id: 548611 }],
    );
    assert.equal(hit, null);
  });
});
