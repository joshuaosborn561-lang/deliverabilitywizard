import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  closedIsolationAskBlocks,
  slackAskResolveStatusFor,
  slackAskResolvedLabel,
} from "./slackAskResolve.js";

describe("slackAskResolve — D195", () => {
  it("maps decisions to closed labels", () => {
    assert.equal(
      slackAskResolvedLabel(slackAskResolveStatusFor("swap_copy", "approve")),
      "Resolved — edit applied",
    );
    assert.equal(
      slackAskResolvedLabel(slackAskResolveStatusFor("swap_copy", "deny")),
      "Resolved — not now",
    );
    assert.equal(
      slackAskResolvedLabel(
        slackAskResolveStatusFor("generic_backfill", "approve"),
      ),
      "Resolved — generics decision recorded",
    );
  });

  it("closed blocks have no actions", () => {
    const blocks = closedIsolationAskBlocks({
      title: "TechEvo AirPods",
      status: "edit_applied",
      resultText: "Done.",
    });
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]?.type, "section");
    assert.ok(!JSON.stringify(blocks).includes('"type":"actions"'));
    assert.match(String((blocks[0] as { text?: { text?: string } }).text?.text), /Resolved — edit applied/);
  });
});
