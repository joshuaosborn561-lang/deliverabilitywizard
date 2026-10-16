import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyLineJob,
  huntCopyWords,
  isBannedCopySwap,
  OFFER_LEAD_SPINTAX,
  preferEllipsis,
  suggestedCopySwap,
} from "./wordHunt.js";

const BANNED_SUB = /air\s*pods?|\btickets?\b|\bTJ\b|free\s+(?:poc|proof of concept)/i;

describe("word hunt D152/D168/D170/D171/D277", () => {
  it("classifies AirPods as a gift-or-experience-offer", () => {
    assert.equal(
      classifyLineJob("I've got a pair of AirPods for you"),
      "gift-or-experience-offer",
    );
  });

  it("never suggests AirPods / tickets / TJ / free POC in REPLACE WITH", () => {
    const air = suggestedCopySwap("I've got a pair of AirPods for you");
    assert.match(air, /I'd like to offer/);
    assert.equal(air.startsWith(OFFER_LEAD_SPINTAX), true);
    assert.doesNotMatch(air, BANNED_SUB);
    assert.doesNotMatch(air, /Quick note/);
    assert.equal(isBannedCopySwap(air), false);

    const tickets = suggestedCopySwap("I've got Red Sox tickets if you want them.");
    assert.match(tickets, /I'd like to offer/);
    assert.doesNotMatch(tickets, BANNED_SUB);

    const tj = suggestedCopySwap("Hey TJ — complimentary trial for you");
    assert.doesNotMatch(tj, BANNED_SUB);

    const poc = suggestedCopySwap("free POC this week");
    assert.doesNotMatch(poc, BANNED_SUB);
  });

  it("sports tickets stay an offer even when the slice truncates", () => {
    assert.equal(
      classifyLineJob("I've got a couple {{Local_Sports_Team"),
      "gift-or-experience-offer",
    );
  });

  it("jet ski still keeps the offer noun", () => {
    const swap = suggestedCopySwap("I've got a jet ski you can take out this weekend.");
    assert.match(swap, /jet\s*ski/i);
    assert.match(swap, /I'd like to offer/);
    assert.doesNotMatch(swap, BANNED_SUB);
  });

  it("defaults use ellipsis never an em dash", () => {
    assert.equal(preferEllipsis("hello — world"), "hello... world");
  });

  it("pure spam tokens swap to a blank delete", () => {
    assert.equal(suggestedCopySwap("congratulations"), "");
    assert.equal(classifyLineJob("congratulations"), "spam-token");
  });

  it("hunts gift-bait out of a sequence body without naming AirPods in the swap", () => {
    const hits = huntCopyWords("Hey — I've got a pair of AirPods for you if you want.\nWinner!");
    assert.ok(hits.some((h) => h.job === "gift-or-experience-offer"));
    const offer = hits.find((h) => h.job === "gift-or-experience-offer");
    assert.ok(offer);
    assert.doesNotMatch(offer!.swap, BANNED_SUB);
    assert.ok(isBannedCopySwap("a pair of AirPods if you would like, on me."));
    assert.ok(isBannedCopySwap("Red Sox tickets if you're interested."));
    assert.ok(isBannedCopySwap("free POC for TJ"));
  });
});
