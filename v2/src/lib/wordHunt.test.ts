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

describe("word hunt D152/D168/D170/D171", () => {
  it("classifies AirPods as a gift-or-experience-offer", () => {
    assert.equal(
      classifyLineJob("I've got a pair of AirPods for you"),
      "gift-or-experience-offer",
    );
  });

  it("keeps the AirPods offer and leads with I'd like to offer", () => {
    const swap = suggestedCopySwap("I've got a pair of AirPods for you");
    assert.match(swap, /AirPods/);
    assert.match(swap, /I'd like to offer/);
    assert.equal(swap.startsWith(OFFER_LEAD_SPINTAX), true);
    assert.doesNotMatch(swap, /Quick note/);
    assert.ok(!isBannedCopySwap(swap));
  });

  it("sports tickets stay an offer even when the slice truncates", () => {
    assert.equal(
      classifyLineJob("I've got a couple {{Local_Sports_Team"),
      "gift-or-experience-offer",
    );
  });

  it("defaults use ellipsis never an em dash", () => {
    assert.equal(preferEllipsis("hello — world"), "hello... world");
  });

  it("pure spam tokens swap to a blank delete", () => {
    assert.equal(suggestedCopySwap("congratulations"), "");
    assert.equal(classifyLineJob("congratulations"), "spam-token");
  });

  it("hunts gift-bait out of a sequence body", () => {
    const hits = huntCopyWords("Hey — I've got a pair of AirPods for you if you want.\nWinner!");
    assert.ok(hits.some((h) => h.job === "gift-or-experience-offer"));
    assert.ok(hits.some((h) => /airpods/i.test(h.phrase) || /AirPods/.test(h.swap)));
  });
});
