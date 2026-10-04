import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emptyGenericSeat } from "./genericPool.js";
import {
  namedWarmSwapReturnCount,
  pickNamedWarmSwapReturns,
} from "./namedWarmSwap.js";

describe("D230 named-warm swap", () => {
  it("returns one generic per named seat that goes warm and never drops below 40", () => {
    assert.equal(
      namedWarmSwapReturnCount({
        namedStaffable: 37,
        assignedCount: 4,
        previousNamedStaffable: 36,
      }),
      1,
    );
    assert.equal(
      namedWarmSwapReturnCount({
        namedStaffable: 36,
        assignedCount: 4,
        previousNamedStaffable: 36,
      }),
      0,
    );
    assert.equal(
      namedWarmSwapReturnCount({
        namedStaffable: 40,
        assignedCount: 3,
        previousNamedStaffable: 38,
      }),
      3,
    );
  });

  it("returns surplus beyond 40 even without a previous count", () => {
    assert.equal(
      namedWarmSwapReturnCount({
        namedStaffable: 40,
        assignedCount: 2,
      }),
      2,
    );
  });

  it("picks the oldest / worst generic first", () => {
    const picked = pickNamedWarmSwapReturns(
      [
        emptyGenericSeat("new@getintroduced.info", {
          assignedAt: "2026-10-04T00:00:00.000Z",
        }),
        emptyGenericSeat("old@getintroduced.info", {
          assignedAt: "2026-10-01T00:00:00.000Z",
        }),
        emptyGenericSeat("mid@getintroduced.info", {
          assignedAt: "2026-10-02T00:00:00.000Z",
        }),
      ],
      1,
    );
    assert.deepEqual(
      picked.map((row) => row.email),
      ["old@getintroduced.info"],
    );
  });
});
