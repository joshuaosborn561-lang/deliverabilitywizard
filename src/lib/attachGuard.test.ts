import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AttachForbiddenSeatError,
  CORNERSTONE_CLIENT_ID,
  accountHasActiveHoldUntil,
  assertAttachAllowedAccountIds,
  isAttachForbiddenSeat,
  isCornerstoneClientSeat,
} from "./attachGuard.js";

describe("D283 attach guard — CornerStone + HOLD-UNTIL", () => {
  const now = new Date("2026-10-16T18:00:00.000Z");

  it("flags CornerStone client seats", () => {
    assert.equal(
      isCornerstoneClientSeat({ client_id: CORNERSTONE_CLIENT_ID }),
      true,
    );
    assert.equal(isCornerstoneClientSeat({ client_id: 574020 }), false);
    assert.equal(
      isAttachForbiddenSeat({ client_id: CORNERSTONE_CLIENT_ID }, now),
      true,
    );
  });

  it("flags an unexpired HOLD-UNTIL-2026-12-31 tag", () => {
    const held = {
      client_id: 574020,
      tags: [{ tag_name: "HOLD-UNTIL-2026-12-31" }],
    };
    assert.equal(accountHasActiveHoldUntil(held, now), true);
    assert.equal(isAttachForbiddenSeat(held, now), true);
    assert.equal(
      accountHasActiveHoldUntil(
        { tags: [{ tag_name: "HOLD-UNTIL-2020-01-01" }] },
        now,
      ),
      false,
    );
  });

  it("assertAttachAllowedAccountIds rejects before a write", () => {
    const accountsById = new Map([
      [73, { id: 73, client_id: CORNERSTONE_CLIENT_ID }],
      [74, { id: 74, tags: [{ tag_name: "HOLD-UNTIL-2026-12-31" }] }],
      [75, { id: 75, client_id: 521881 }],
    ]);
    assert.throws(
      () => assertAttachAllowedAccountIds(1001, [73], { accountsById, now }),
      AttachForbiddenSeatError,
    );
    assert.throws(
      () => assertAttachAllowedAccountIds(1001, [74], { accountsById, now }),
      AttachForbiddenSeatError,
    );
    assert.doesNotThrow(() =>
      assertAttachAllowedAccountIds(1001, [75], { accountsById, now }),
    );
    assert.doesNotThrow(() =>
      assertAttachAllowedAccountIds(1001, [99], { accountsById, now }),
    );
  });
});
