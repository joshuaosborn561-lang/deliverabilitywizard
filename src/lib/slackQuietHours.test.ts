import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isJoshQuietHours, isNeedsYouWeekdayMorning } from "./slackQuietHours.js";

describe("D248 — Josh quiet hours (8pm–6am CT + weekends)", () => {
  it("queues overnight and weekend, not weekday daytime", () => {
    // Thursday 2026-10-08 02:00 UTC = Wednesday 9pm CT (CDT).
    assert.equal(isJoshQuietHours(new Date("2026-10-08T02:00:00.000Z")), true);
    // Thursday 2026-10-08 12:00 UTC = Thursday 7am CT.
    assert.equal(isJoshQuietHours(new Date("2026-10-08T12:00:00.000Z")), false);
    // Saturday 2026-10-10 15:00 UTC = Saturday 10am CT.
    assert.equal(isJoshQuietHours(new Date("2026-10-10T15:00:00.000Z")), true);
    // Friday 2026-10-09 13:00 UTC = Friday 8am CT.
    assert.equal(isNeedsYouWeekdayMorning(new Date("2026-10-09T13:00:00.000Z")), true);
  });
});
