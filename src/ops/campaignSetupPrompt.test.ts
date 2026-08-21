import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { campaignSetupPrompt } from "./campaignSetupPrompt.js";

describe("campaignSetupPrompt", () => {
  it("tells Claude the D41 campaign-setup rails", () => {
    const prompt = campaignSetupPrompt();
    assert.match(prompt, /50 \*staffable\*/);
    assert.match(prompt, /2 weeks on \/ 2 weeks off/);
    assert.match(prompt, /15%/);
    assert.match(prompt, /21 days/);
    assert.match(prompt, /do not auto-START/i);
    assert.match(prompt, /MESSAGE_PER_DAY=0/);
    assert.match(prompt, /Do not buy a third client-domain set/);
  });
});
