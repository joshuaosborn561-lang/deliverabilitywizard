import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { campaignSetupPrompt } from "./campaignSetupPrompt.js";

describe("campaignSetupPrompt", () => {
  it("tells Claude the current campaign-setup rails", () => {
    const prompt = campaignSetupPrompt();
    assert.match(prompt, /half that client's own inboxes/);
    assert.match(prompt, /Vasco is not special/);
    assert.match(prompt, /Split that client's inboxes into A and B/);
    assert.match(prompt, /30% Google/);
    assert.match(prompt, /14 days of live send/);
    assert.match(prompt, /21 days/);
    assert.match(prompt, /Bounce autostop \(D80\)/);
    assert.match(prompt, /MESSAGE_PER_DAY=0/);
    assert.match(prompt, /rebuilds unproven HOLDs/);
    assert.match(prompt, /unlimited/i);
    assert.match(prompt, /≤50 senders per test/);
    assert.match(prompt, /85%/);
    assert.match(prompt, /known-good copy canary/);
    assert.match(prompt, /unwarmed fleet canary/);
    assert.doesNotMatch(prompt, /launch canary/i);
    assert.doesNotMatch(prompt, /Quota is 120/);
    assert.match(prompt, /never edits the live sequence/i);
    assert.match(prompt, /do not hold a copy teardown for seed approval/i);
  });
});
