import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isExcluded } from "./campaignTopUp.js";

describe("isExcluded", () => {
  const msrs = { id: 3628940, name: "MSRS2 Ticket Offer Property Manager" };
  const parlay = { id: 3628957, name: "Parlay2 Sports Offer" };

  it("excludes nothing when no patterns are configured", () => {
    assert.equal(isExcluded(msrs, []), false);
  });

  it("matches a name fragment case-insensitively", () => {
    assert.equal(isExcluded(msrs, ["msrs"]), true);
    assert.equal(isExcluded(msrs, ["MSRS"]), true);
    assert.equal(isExcluded(parlay, ["msrs"]), false);
  });

  it("matches an exact campaign id", () => {
    assert.equal(isExcluded(msrs, ["3628940"]), true);
    assert.equal(isExcluded(parlay, ["3628940"]), false);
  });

  it("does not treat an id as a substring of another id", () => {
    // "628940" must not knock out 3628940 by accident.
    assert.equal(isExcluded(msrs, ["628940"]), false);
  });

  it("ignores blank patterns", () => {
    assert.equal(isExcluded(msrs, ["", "   "]), false);
  });

  it("handles a missing campaign name", () => {
    assert.equal(isExcluded({ id: 1, name: null }, ["msrs"]), false);
    assert.equal(isExcluded({ id: 1, name: null }, ["1"]), true);
  });
});
