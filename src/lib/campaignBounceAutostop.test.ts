import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  campaignBounceAutostopThreshold,
  shouldAutostopCampaignForBounce,
} from "./campaignBounceAutostop.js";

describe("campaignBounceAutostopThreshold (D80)", () => {
  it("does not treat bounce rate as evidence under 100 sends", () => {
    assert.equal(campaignBounceAutostopThreshold(0), null);
    assert.equal(campaignBounceAutostopThreshold(10), null);
    assert.equal(campaignBounceAutostopThreshold(99), null);
    assert.equal(shouldAutostopCampaignForBounce(10, 40), false);
  });

  it("is 20% from 100 through 499 sends", () => {
    assert.equal(campaignBounceAutostopThreshold(100), 20);
    assert.equal(campaignBounceAutostopThreshold(499), 20);
    assert.equal(shouldAutostopCampaignForBounce(150, 20), false);
    assert.equal(shouldAutostopCampaignForBounce(150, 20.1), true);
  });

  it("is 7% from 500 sends up", () => {
    assert.equal(campaignBounceAutostopThreshold(500), 7);
    assert.equal(campaignBounceAutostopThreshold(10_000), 7);
    assert.equal(shouldAutostopCampaignForBounce(500, 7), false);
    assert.equal(shouldAutostopCampaignForBounce(500, 7.1), true);
  });
});
