import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addDaysIso, scheduleStartTime } from "./campaignScanner.js";

describe("scheduleStartTime", () => {
  it("pads forward from now by the given buffer", () => {
    const now = new Date("2026-08-03T09:00:00.000Z");
    const result = scheduleStartTime(2, now);
    assert.equal(result, "2026-08-03T09:02:00.000Z");
  });

  it("defaults to a 2-minute buffer", () => {
    const now = new Date("2026-08-03T09:00:00.000Z");
    const result = scheduleStartTime(undefined, now);
    assert.equal(result, "2026-08-03T09:02:00.000Z");
  });

  it("is always strictly after the moment it was generated, even accounting for request latency", () => {
    const before = Date.now();
    const result = Date.parse(scheduleStartTime());
    // Simulate a slow request: SmartDelivery validates against its own clock
    // some time after we generated the timestamp. A few seconds of latency
    // must not be enough to put our timestamp in the past.
    const serverNowAfterLatency = before + 5_000;
    assert.ok(
      result >= serverNowAfterLatency,
      `expected ${result} to be >= ${serverNowAfterLatency} (now + 5s latency)`,
    );
  });
});

describe("addDaysIso", () => {
  it("adds whole UTC days", () => {
    const result = addDaysIso(new Date("2026-08-03T09:00:00.000Z"), 3);
    assert.equal(result, "2026-08-06T09:00:00.000Z");
  });
});
