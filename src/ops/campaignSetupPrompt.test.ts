import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { campaignSetupPrompt } from "./campaignSetupPrompt.js";

describe("campaignSetupPrompt", () => {
  it("tells Claude the D43 campaign-setup rails", () => {
    const prompt = campaignSetupPrompt();
    assert.match(prompt, /50 \*staffable\*/);
    assert.match(prompt, /Split that client's inboxes into A and B/);
    assert.match(prompt, /30% Google/);
    assert.match(prompt, /14 days of live send/);
    assert.match(prompt, /21 days/);
    assert.match(prompt, /do not auto-START/i);
    assert.match(prompt, /MESSAGE_PER_DAY=0/);
    assert.match(prompt, /rebuilds unproven HOLDs/);
    assert.doesNotMatch(prompt, /canary/i);
  });
});
