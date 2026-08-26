import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  confirmSuppressedTerm,
  lintCopyAgainstTerms,
  retireStaleTerms,
} from "./suppressedTerms.js";

describe("suppressed terms", () => {
  it("confirms a trigger and warns on lint without blocking", () => {
    const term = confirmSuppressedTerm(undefined, {
      term: "free",
      kind: "word",
      at: "2026-08-23T00:00:00.000Z",
      clientScope: "bcp",
    });
    const hits = lintCopyAgainstTerms(
      { subject: "Free consult", body: "A complimentary note" },
      [term],
      "bcp",
    );
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.term, "free");
    const otherClient = lintCopyAgainstTerms(
      { subject: "Free consult", body: "" },
      [term],
      "parlay",
    );
    assert.equal(otherClient.length, 0);
  });

  it("retires a seasonal term after it goes stale", () => {
    const [retired] = retireStaleTerms(
      [
        {
          term: "winner",
          kind: "word",
          firstSeen: "2025-01-01T00:00:00.000Z",
          timesConfirmed: 1,
          status: "confirmed",
        },
      ],
      new Date("2026-08-23T00:00:00.000Z"),
    );
    assert.equal(retired?.status, "retired");
  });
});
