import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { holdHasSameEspProof } from "./holdProof.js";

describe("holdHasSameEspProof", () => {
  it("keeps a mailbox that failed same-ESP (D32/D44)", () => {
    assert.equal(
      holdHasSameEspProof(
        { scoredSameEsp: true, inboxRateSameEsp: 40, inboxRate: 90 },
        80,
      ),
      true,
    );
  });

  it("releases no-score and blended-only holds", () => {
    assert.equal(
      holdHasSameEspProof({ scoredSameEsp: null, inboxRate: 40 }, 80),
      false,
    );
    assert.equal(
      holdHasSameEspProof(
        { scoredSameEsp: false, inboxRateAll: 40, inboxRate: 40 },
        80,
      ),
      false,
    );
  });

  it("releases a hold whose same-ESP is already fine", () => {
    assert.equal(
      holdHasSameEspProof(
        { scoredSameEsp: true, inboxRateSameEsp: 92 },
        80,
      ),
      false,
    );
  });
});
