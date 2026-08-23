import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  campaignSenderControl,
  placementFromInboxRate,
  podVerdictFromSenders,
  tagFromPlacements,
} from "./mailboxControlTag.js";

describe("mailbox control tags", () => {
  it("does not tag from a blended score", () => {
    assert.equal(
      placementFromInboxRate({ inboxRate: 10, scoredSameEsp: false }),
      "UNKNOWN",
    );
    assert.equal(
      placementFromInboxRate({ inboxRate: 90, scoredSameEsp: true }),
      "PRIMARY",
    );
    assert.equal(
      placementFromInboxRate({ inboxRate: 40, scoredSameEsp: true }),
      "SPAM",
    );
  });

  it("keep / watch / kill from recent fails only", () => {
    assert.equal(tagFromPlacements(["PRIMARY", "PRIMARY", "PRIMARY"]), "keep");
    assert.equal(tagFromPlacements(["PRIMARY", "SPAM", "PRIMARY"]), "watch");
    assert.equal(tagFromPlacements(["SPAM", "SPAM", "PRIMARY"]), "kill");
  });

  it("campaign reading uses that campaign's senders, not a pod average", () => {
    assert.equal(campaignSenderControl(["PRIMARY", "PRIMARY"]), "CLEAN");
    assert.equal(campaignSenderControl(["PRIMARY", "SPAM"]), "FAILING");
    assert.equal(campaignSenderControl(["UNKNOWN", "UNKNOWN"]), "INSUFFICIENT");
    assert.equal(
      podVerdictFromSenders(["PRIMARY", "PRIMARY", "SPAM"]),
      "DEGRADED",
    );
  });
});
