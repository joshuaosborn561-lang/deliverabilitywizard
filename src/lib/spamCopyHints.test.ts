import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatSpamCopySlackLines,
  plainTextFromHtml,
  suggestSpamCopyChanges,
} from "./spamCopyHints.js";

describe("spamCopyHints", () => {
  it("strips html for scanning", () => {
    assert.equal(
      plainTextFromHtml("<p>Hey {{first_name}},</p><p>Got a pair of AirPods</p>"),
      "Hey {{first_name}}, Got a pair of AirPods",
    );
  });

  it("flags gift bait and urgency with concrete changes", () => {
    const hints = suggestSpamCopyChanges({
      subject: "Act now — limited time",
      bodyHtml:
        "<p>Got a pair of AirPods on me. Click here to claim your gift.</p>",
    });
    const triggers = hints.map((h) => h.trigger);
    assert.ok(triggers.some((t) => /gift/i.test(t)));
    assert.ok(triggers.some((t) => /urgency/i.test(t)));
    assert.ok(triggers.some((t) => /promo CTA/i.test(t)));
    assert.ok(hints.every((h) => h.change.length > 20));
  });

  it("formats slack lines with campaign id and subject", () => {
    const lines = formatSpamCopySlackLines({
      campaignId: 3781913,
      campaignName: "Goliath L3",
      subject: "small thank you",
      spamPercent: 62,
      hints: [
        {
          trigger: "gift / freebie bait",
          found: "AirPods",
          change: "Lead with the business problem first.",
        },
      ],
    });
    assert.ok(lines.some((l) => /#3781913/.test(l) && /Goliath/.test(l)));
    assert.ok(lines.some((l) => /Copy changes/.test(l)));
    assert.ok(lines.some((l) => /AirPods/.test(l)));
  });

  it("still advises when no keyword hits", () => {
    const lines = formatSpamCopySlackLines({
      campaignId: 1,
      campaignName: "Plain",
      hints: [],
      spamPercent: 40,
    });
    assert.ok(lines.some((l) => /No classic spam-trigger/i.test(l)));
  });
});
