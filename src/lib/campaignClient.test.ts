import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchClientForCampaign } from "./campaignClient.js";

const clients = [
  { id: 548611, name: "Dave Ackley", logo: "Goliath Cybersecurity" },
  { id: 548610, name: "Peterson", logo: "Roofs by Peterson" },
  { id: 1, name: "Randy Haba", logo: "Parlay Tech" },
  { id: 2, name: "BCP", logo: "Bolder Cyber Partners" },
];

describe("matchClientForCampaign (D77)", () => {
  it("assigns Goliath from the campaign name", () => {
    assert.equal(
      matchClientForCampaign("Goliath Displacement M 201-500 CIO", clients)?.id,
      548611,
    );
  });

  it("assigns Peterson and BCP from the campaign name", () => {
    assert.equal(
      matchClientForCampaign("Peterson - C3 Churches - SPORTS", clients)?.id,
      548610,
    );
    assert.equal(
      matchClientForCampaign("BCP Under-1k", clients)?.id,
      2,
    );
  });

  it("does not guess when no client matches", () => {
    assert.equal(matchClientForCampaign("Pod control shell", clients), null);
  });

  it("does not treat a generic word like tech as Parlay", () => {
    assert.equal(
      matchClientForCampaign("Nieto Sports or Airpods Offer/Proprietary Tech", clients),
      null,
    );
  });
});
