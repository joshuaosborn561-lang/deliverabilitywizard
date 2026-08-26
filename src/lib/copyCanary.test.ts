import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { interpretCopyCanary, majorityLanded } from "./copyCanary.js";

describe("copy canary signal", () => {
  it("treats a majority inbox as landed", () => {
    assert.equal(majorityLanded(2, 3), true);
    assert.equal(majorityLanded(1, 3), false);
    assert.equal(majorityLanded(0, 0), null);
  });

  it("unwarmed landing + warmed failing is infra, not copy", () => {
    const reading = interpretCopyCanary({
      unwarmedLanded: true,
      warmedLanded: false,
      unwarmedTested: 3,
      warmedTested: 40,
      unwarmedInbox: 3,
      warmedInbox: 10,
    });
    assert.equal(reading.lean, "INFRA");
  });

  it("both burying campaign copy leans copy", () => {
    const reading = interpretCopyCanary({
      unwarmedLanded: false,
      warmedLanded: false,
      unwarmedTested: 3,
      warmedTested: 40,
      unwarmedInbox: 0,
      warmedInbox: 5,
    });
    assert.equal(reading.lean, "COPY");
  });

  it("cold fail + warmed land is warmup, not a word hunt", () => {
    const reading = interpretCopyCanary({
      unwarmedLanded: false,
      warmedLanded: true,
      unwarmedTested: 3,
      warmedTested: 40,
      unwarmedInbox: 0,
      warmedInbox: 38,
    });
    assert.equal(reading.lean, "WARMUP");
  });
});
