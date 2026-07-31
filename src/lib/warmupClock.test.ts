import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { earliestWarmupStart } from "./warmupClock.js";

const iso = (daysAgo: number) =>
  new Date(Date.now() - daysAgo * 86_400_000).toISOString();

describe("earliestWarmupStart", () => {
  it("prefers Smartlead's older start over a late-created state row", () => {
    // The production bug: state was rebuilt today for a mailbox that has been
    // warming for 30 days, resetting its clock and holding it back 14 more.
    const stateRow = iso(0);
    const smartlead = iso(30);
    const result = earliestWarmupStart(stateRow, smartlead, iso(0));
    assert.equal(result, smartlead);
  });

  it("keeps the stored value when it is the oldest", () => {
    const stored = iso(20);
    assert.equal(earliestWarmupStart(stored, iso(5), iso(0)), stored);
  });

  it("falls back to now when nothing valid is supplied", () => {
    const before = Date.now();
    const result = Date.parse(earliestWarmupStart(null, undefined, iso(0)));
    assert.ok(result >= before - 5_000 && result <= Date.now() + 5_000);
  });

  it("ignores unparseable values", () => {
    const good = iso(10);
    assert.equal(earliestWarmupStart("not-a-date", good), good);
  });

  it("rejects a future date so a mailbox cannot be stuck warming forever", () => {
    const future = new Date(Date.now() + 40 * 86_400_000).toISOString();
    const real = iso(15);
    assert.equal(earliestWarmupStart(future, real), real);
  });

  it("returns now when the only candidate is in the future", () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const result = Date.parse(earliestWarmupStart(future));
    assert.ok(Math.abs(result - Date.now()) < 5_000);
  });
});
