import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  copyChangeText,
  scoreSpamAssassin,
  spamAssassinBlocksApproval,
} from "./spamAssassin.js";

describe("SpamAssassin copy score", () => {
  it("scores a normal cold-email line at 0", () => {
    const scored = scoreSpamAssassin(
      "Subject: quick note\nHi {{first_name}} — we help shops book more estimates. Reply stop to opt out.",
    );
    assert.equal(scored.score, 0);
    assert.equal(scored.hits.length, 0);
    assert.equal(spamAssassinBlocksApproval(scored.score), false);
  });

  it("scores dear-friend plus a bang guarantee above 0", () => {
    const scored = scoreSpamAssassin(
      "Dear friend, this is guaranteed! Act now.",
    );
    assert.ok(scored.score > 0);
    assert.ok(scored.hits.some((hit) => hit.rule === "DEAR_FRIEND"));
    assert.ok(scored.hits.some((hit) => hit.rule === "BANG_GUAR"));
    assert.equal(spamAssassinBlocksApproval(scored.score), true);
  });

  it("reads the proposed swap, not the old line", () => {
    const text = copyChangeText({
      element: "old line",
      swap: "Dear friend, guaranteed!",
    });
    assert.match(text, /Dear friend/);
    assert.equal(spamAssassinBlocksApproval(scoreSpamAssassin(text).score), true);
  });
});
