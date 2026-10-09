import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  chicagoYmdOfIso,
  inWeekdayCatchUpWindow,
  terlEodCatchUpDue,
  weekdayJobMissed,
} from "./weekdayCatchUp.js";

describe("weekday catch-up window (D249)", () => {
  it("is weekday 6am–8pm CT only", () => {
    // Friday 2026-10-09 13:16Z = 08:16 CT.
    assert.equal(
      inWeekdayCatchUpWindow(new Date("2026-10-09T13:16:00.000Z")),
      true,
    );
    // Friday 05:59 CT = 10:59Z.
    assert.equal(
      inWeekdayCatchUpWindow(new Date("2026-10-09T10:59:00.000Z")),
      false,
    );
    // Friday 20:00 CT = 01:00Z Saturday.
    assert.equal(
      inWeekdayCatchUpWindow(new Date("2026-10-10T01:00:00.000Z")),
      false,
    );
    // Saturday 10:00 CT.
    assert.equal(
      inWeekdayCatchUpWindow(new Date("2026-10-10T15:00:00.000Z")),
      false,
    );
  });

  it("treats a missing or other-day stamp as a missed weekday job", () => {
    assert.equal(weekdayJobMissed("2026-10-05", "2026-10-09"), true);
    assert.equal(weekdayJobMissed(null, "2026-10-09"), true);
    assert.equal(weekdayJobMissed("2026-10-09", "2026-10-09"), false);
  });

  it("TERRL EOD catch-up waits until 17:30 CT", () => {
    assert.equal(
      terlEodCatchUpDue(new Date("2026-10-09T16:00:00.000Z")),
      false,
      "11:00 CT is before 17:30",
    );
    assert.equal(
      terlEodCatchUpDue(new Date("2026-10-09T22:30:00.000Z")),
      true,
      "17:30 CT Friday is due",
    );
    assert.equal(
      terlEodCatchUpDue(new Date("2026-10-11T22:30:00.000Z")),
      false,
      "Sunday stays gated",
    );
  });

  it("reads a Chicago YMD from an ISO stamp", () => {
    assert.equal(chicagoYmdOfIso("2026-10-05T13:16:00.000Z"), "2026-10-05");
    assert.equal(chicagoYmdOfIso("not-a-date"), null);
  });
});
