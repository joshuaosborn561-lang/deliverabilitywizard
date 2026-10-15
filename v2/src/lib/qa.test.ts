import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { insightSequenceIllegal } from "./signature.js";
import { mergeTagHoles, step2DelayWrong } from "./qa.js";
import { bounceRateIsEvidence, bounceLoopMayPause, classifyBounceReason } from "./bounce.js";

describe("copy / bounce QA", () => {
  it("D180: blank merge tags are findings, not writes", () => {
    assert.deepEqual(
      mergeTagHoles({
        body: "Hi {{first_name}}, %signature%",
        customFields: { first_name: "" },
      }),
      ["first_name"],
    );
  });

  it("D186: step 2 must be 2 days", () => {
    assert.equal(step2DelayWrong(1), true);
    assert.equal(step2DelayWrong(2), false);
  });

  it("D255: Insight in-body Josh Osborn / Insight close is illegal", () => {
    assert.equal(insightSequenceIllegal("Thanks\nJosh Osborn\nInsight"), true);
    assert.equal(insightSequenceIllegal("See you\n%signature%"), false);
  });

  it("D5: bounce rate needs 50 sends", () => {
    assert.equal(bounceRateIsEvidence({ bounceRate: 33, sent: 3 }), false);
    assert.equal(bounceRateIsEvidence({ bounceRate: 6, sent: 50 }), true);
  });

  it("D148: bounce loop never pauses", () => {
    assert.equal(bounceLoopMayPause(), false);
  });

  it("D145: 5.1.8 is tenant_outbound_block", () => {
    assert.equal(classifyBounceReason("550 5.1.8 AS(42004)"), "tenant_outbound_block");
    assert.equal(classifyBounceReason("550 5.7.233"), "tenant_rate_limit");
  });
});
