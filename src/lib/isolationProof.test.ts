import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { campaignProof, copySwapProof } from "./isolationProof.js";

describe("isolation proof", () => {
  it("says what was run and why it is not the other cause", () => {
    const text = campaignProof({
      verdict: "COPY",
      controlVersion: "ctl-abc",
      senderSummary: "12 inboxes on this campaign",
      whyNotTheOther:
        "Why not the inboxes: the same inboxes landed the known-good email.",
      next: "I will not edit the live email until someone taps Make the changes.",
    });
    assert.match(text, /known-good email/);
    assert.match(text, /unwarmed senders with that campaign copy/);
    assert.match(text, /Why not the inboxes/);
    assert.doesNotMatch(text, /\bD48\b/);
  });

  it("copy swap proof asks for a Slack tap", () => {
    const text = copySwapProof({
      campaignName: "Acme",
      element: "free",
      swap: "complimentary",
      controlLanded: true,
    });
    assert.match(text, /It was the word \*free\*/);
    assert.match(text, /complimentary/);
    assert.match(text, /keeps the line/);
    assert.match(text, /Make the changes\?/);
  });
});
