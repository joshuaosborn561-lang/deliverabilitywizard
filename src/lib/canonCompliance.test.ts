import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { campaignCanonYes, canonBoard } from "./canonCompliance.js";

describe("canon compliance (D108)", () => {
  it("yes when core holes are closed", () => {
    assert.equal(campaignCanonYes([]), true);
    assert.equal(campaignCanonYes(["below_launch_bar: 70%"]), true);
    assert.equal(campaignCanonYes(["missing_client_tag: none"]), true);
  });

  it("no when a core hole is open", () => {
    assert.equal(campaignCanonYes(["under_warmed: a@x 3d"]), false);
    assert.equal(campaignCanonYes(["missing_canary: none"]), false);
    assert.equal(campaignCanonYes(["mailbox_gap: 1m"]), false);
  });

  it("board is all-yes only when every campaign is yes", () => {
    const board = canonBoard([
      {
        campaignId: 1,
        name: "A",
        firstSeenAt: "",
        firstCheckAt: null,
        firstPassedAt: null,
        lastSweepAt: null,
        lastKind: "first",
        findings: [],
      },
      {
        campaignId: 2,
        name: "B",
        firstSeenAt: "",
        firstCheckAt: null,
        firstPassedAt: null,
        lastSweepAt: null,
        lastKind: "hourly",
        findings: ["understaffed: 10/20"],
      },
    ]);
    assert.equal(board.compliant, false);
    assert.equal(board.campaigns[0]!.yes, true);
    assert.equal(board.campaigns[1]!.yes, false);
  });
});
