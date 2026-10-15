import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inStaffingHours, isQuietHours, mayPostSlack } from "./quietHours.js";

describe("D276 quiet hours — weekdays 6am–8pm CT", () => {
  it("allows Thursday 10am CT", () => {
    const now = new Date("2026-10-15T15:00:00.000Z");
    assert.equal(inStaffingHours(now), true);
    assert.equal(isQuietHours(now), false);
    assert.equal(mayPostSlack(now), true);
  });

  it("blocks Thursday 10pm CT", () => {
    const now = new Date("2026-10-16T03:00:00.000Z");
    assert.equal(inStaffingHours(now), false);
    assert.equal(isQuietHours(now), true);
    assert.equal(mayPostSlack(now), false);
  });

  it("blocks Saturday 10am CT", () => {
    const now = new Date("2026-10-17T15:00:00.000Z");
    assert.equal(inStaffingHours(now), false);
    assert.equal(isQuietHours(now), true);
  });

  it("allows Friday 6am CT and blocks 8pm CT", () => {
    assert.equal(inStaffingHours(new Date("2026-10-16T11:00:00.000Z")), true);
    assert.equal(inStaffingHours(new Date("2026-10-17T01:00:00.000Z")), false);
  });
});
