import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GENERIC_ASSIGN_REASON_POD_TOP_UP,
  applyAssignGenericSeat,
  applyReleaseGenericSeat,
  emptyGenericSeat,
  mergeSeededGenericSeat,
} from "./genericPool.js";
import {
  genericPoolCanonCompliant,
  genericPoolFindingLine,
  validateGenericPool,
} from "./genericPoolCanon.js";

describe("D231 generic seat table assign/release", () => {
  it("refuses a hand-out that is not already a table row", () => {
    const result = applyAssignGenericSeat(undefined, {
      email: "ghost@getintroduced.info",
      clientId: 77,
      pod: "A",
      reason: GENERIC_ASSIGN_REASON_POD_TOP_UP,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, "missing_from_table");
  });

  it("blocks a second client and a POD rotate", () => {
    const seat = emptyGenericSeat("ada@getintroduced.info", {
      assignedClientId: 77,
      assignedPod: "A",
      assignedAt: "2026-10-01T00:00:00.000Z",
      reason: GENERIC_ASSIGN_REASON_POD_TOP_UP,
    });
    const other = applyAssignGenericSeat(seat, {
      email: seat.email,
      clientId: 88,
      pod: "A",
      reason: GENERIC_ASSIGN_REASON_POD_TOP_UP,
    });
    assert.equal(other.ok, false);
    if (!other.ok) assert.equal(other.error, "other_client");

    const flip = applyAssignGenericSeat(seat, {
      email: seat.email,
      clientId: 77,
      pod: "B",
      reason: GENERIC_ASSIGN_REASON_POD_TOP_UP,
    });
    assert.equal(flip.ok, false);
    if (!flip.ok) assert.equal(flip.error, "pod_rotate");
  });

  it("assigns through the table and records released_at history", () => {
    const free = emptyGenericSeat("ada@getintroduced.info", { slAccountId: 9 });
    const assigned = applyAssignGenericSeat(free, {
      email: free.email,
      clientId: 77,
      pod: "A",
      reason: GENERIC_ASSIGN_REASON_POD_TOP_UP,
      campaignIds: [10],
      now: new Date("2026-10-03T12:00:00.000Z"),
    });
    assert.equal(assigned.ok, true);
    if (!assigned.ok) return;
    assert.equal(assigned.seat.assignedClientId, 77);
    assert.equal(assigned.seat.assignedPod, "A");
    assert.equal(assigned.seat.assignedAt, "2026-10-03T12:00:00.000Z");
    assert.deepEqual(assigned.seat.assignedCampaignIds, [10]);

    const released = applyReleaseGenericSeat(assigned.seat, {
      now: new Date("2026-10-04T12:00:00.000Z"),
      reason: "surplus_return",
    });
    assert.equal(released.assignedClientId, null);
    assert.equal(released.assignedPod, null);
    assert.equal(released.releasedAt, "2026-10-04T12:00:00.000Z");
    assert.equal(released.releaseHistory.length, 1);
    assert.deepEqual(released.releaseHistory[0], {
      releasedAt: "2026-10-04T12:00:00.000Z",
      clientId: 77,
      pod: "A",
      reason: "surplus_return",
    });
  });

  it("preserves release history when a seed sync clears a live assignment", () => {
    const existing = emptyGenericSeat("ada@getintroduced.info", {
      assignedClientId: 77,
      assignedPod: "A",
      assignedAt: "2026-10-01T00:00:00.000Z",
      reason: GENERIC_ASSIGN_REASON_POD_TOP_UP,
      releaseHistory: [
        {
          releasedAt: "2026-09-01T00:00:00.000Z",
          clientId: 55,
          pod: "B",
          reason: "cleanup",
        },
      ],
    });
    const next = emptyGenericSeat("ada@getintroduced.info", {
      slAccountId: 9,
    });
    const merged = mergeSeededGenericSeat(
      existing,
      next,
      new Date("2026-10-04T00:00:00.000Z"),
    );
    assert.equal(merged.assignedClientId, null);
    assert.equal(merged.releaseHistory.length, 2);
    assert.equal(merged.releaseHistory[1]?.clientId, 77);
    assert.equal(merged.releaseHistory[1]?.reason, GENERIC_ASSIGN_REASON_POD_TOP_UP);
    assert.equal(merged.releasedAt, "2026-10-04T00:00:00.000Z");
  });

  it("flags a live assignment that is missing from the table", () => {
    const findings = validateGenericPool({
      seats: [emptyGenericSeat("free@getintroduced.info")],
      namedStaffableByClientPod: new Map(),
      liveClientIdsByEmail: new Map([
        ["ghost@getintroduced.info", [77]],
        ["free@getintroduced.info", [77]],
      ]),
    });
    const outside = findings.filter((row) => row.kind === "generic_outside_table");
    assert.equal(outside.length, 2);
    assert.ok(outside.some((row) => row.email === "ghost@getintroduced.info"));
    assert.ok(outside.some((row) => row.email === "free@getintroduced.info"));
    assert.equal(
      genericPoolCanonCompliant(outside.map(genericPoolFindingLine)),
      false,
    );
  });
});
