import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { campaignSetupPrompt } from "./campaignSetupPrompt.js";

describe("campaignSetupPrompt", () => {
  it("tells Claude the D43 campaign-setup rails", () => {
    const prompt = campaignSetupPrompt();
    assert.match(prompt, /50 \*staffable\*/);
    assert.match(prompt, /POD-A or POD-B/);
    assert.match(prompt, /on-week/);
    assert.match(prompt, /30% Google/);
    assert.match(prompt, /14 days of live send/);
    assert.match(prompt, /21 days/);
    assert.match(prompt, /do not auto-START/i);
    assert.match(prompt, /MESSAGE_PER_DAY=0/);
    assert.match(prompt, /rebuilds unproven HOLDs/);
    assert.match(prompt, /unlimited/i);
    assert.match(prompt, /≤50 senders per test/);
    assert.match(prompt, /85%/);
    assert.match(prompt, /D55 canary-copy/);
    assert.doesNotMatch(prompt, /launch canary/i);
    assert.doesNotMatch(prompt, /Quota is 120/);
    assert.match(prompt, /never edits the live sequence/i);
    assert.match(prompt, /do not hold a copy teardown for seed approval/i);
  });
});
