import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { burnChecklistReady } from "./burnChecklist.js";

describe("burnChecklistReady", () => {
  it("refuses a blacklist-only hit", () => {
    const result = burnChecklistReady({
      namedBlacklist: true,
      sameEspInbox: null,
      bounceRate: null,
      sent: 0,
    });
    assert.equal(result.ready, false);
    assert.ok(result.reasons.some((r) => /corroborating/i.test(r)));
  });

  it("is ready when a named list plus same-ESP fail agree", () => {
    const result = burnChecklistReady({
      namedBlacklist: true,
      sameEspInbox: 40,
      scoredSameEsp: true,
      bounceRate: 1,
      sent: 200,
    });
    assert.equal(result.ready, true);
    assert.deepEqual(result.reasons, []);
  });

  it("is ready when a named list plus bounce-over-threshold agree", () => {
    const result = burnChecklistReady({
      namedBlacklist: true,
      sameEspInbox: 95,
      scoredSameEsp: true,
      bounceRate: 8,
      sent: 80,
    });
    assert.equal(result.ready, true);
  });

  it("ignores blended placement as corroboration", () => {
    const result = burnChecklistReady({
      namedBlacklist: true,
      sameEspInbox: 10,
      scoredSameEsp: false,
      bounceRate: 1,
      sent: 200,
    });
    assert.equal(result.ready, false);
  });
});
