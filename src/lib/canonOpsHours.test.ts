import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canonOpsIdleReason,
  chicagoWallClock,
  isCanonOpsBusinessHours,
  weekendWriterIdleReason,
} from "./canonOpsHours.js";

describe("canon ops weekday Chicago hours (D205)", () => {
  it("treats a Tuesday 10:00 Chicago as in hours", () => {
    // 2026-09-29 is a Tuesday. 15:00 UTC is 10:00 CDT.
    const now = new Date("2026-09-29T15:00:00Z");
    assert.equal(chicagoWallClock(now).ymd, "2026-09-29");
    assert.equal(chicagoWallClock(now).weekday, 2);
    assert.equal(isCanonOpsBusinessHours({ now }), true);
    assert.equal(canonOpsIdleReason({ now }), undefined);
  });

  it("idles on Saturday and before 08:00 / at 18:00 Chicago", () => {
    const saturday = new Date("2026-10-03T15:00:00Z");
    assert.equal(isCanonOpsBusinessHours({ now: saturday }), false);
    assert.match(canonOpsIdleReason({ now: saturday }) ?? "", /weekday/);

    const early = new Date("2026-09-29T12:30:00Z"); // 07:30 CDT
    assert.equal(isCanonOpsBusinessHours({ now: early }), false);

    const closing = new Date("2026-09-29T23:00:00Z"); // 18:00 CDT
    assert.equal(isCanonOpsBusinessHours({ now: closing }), false);
  });

  it("D234: weekend writers idle unless Josh-live", () => {
    const saturday = new Date("2026-10-04T02:24:00Z"); // Sat 9:24pm CT
    assert.match(weekendWriterIdleReason({ now: saturday }) ?? "", /weekend/);
    assert.equal(
      weekendWriterIdleReason({ now: saturday, joshLive: true }),
      undefined,
    );
    const monday = new Date("2026-10-05T14:00:00Z");
    assert.equal(weekendWriterIdleReason({ now: monday }), undefined);
  });
});
