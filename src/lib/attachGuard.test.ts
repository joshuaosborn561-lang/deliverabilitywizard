import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AttachForbiddenSeatError,
  CORNERSTONE_CLIENT_ID,
  MAREKBROOKS_EMAIL,
  POWERGRYD_MAREK_CAMPAIGN_ID,
  accountHasActiveHoldUntil,
  assertAttachAllowedAccountIds,
  indexAttachForbiddenAccountIds,
  isAttachForbiddenSeat,
  isCornerstoneClientSeat,
  isDoNotRelinkPair,
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

  it("indexes forbidden seats from the inventory book only", () => {
    const forbidden = indexAttachForbiddenAccountIds(
      [
        { id: 73, client_id: CORNERSTONE_CLIENT_ID },
        { id: 74, tags: [{ tag_name: "HOLD-UNTIL-2026-12-31" }] },
        { id: 75, client_id: 521881 },
        { id: 76, tags: [{ tag_name: "HOLD-UNTIL-2020-01-01" }] },
      ],
      now,
    );
    assert.deepEqual([...forbidden].sort((a, b) => a - b), [73, 74]);
  });
});

describe("D287 marekbrooks do-not-relink", () => {
  it("blocks only marekbrooks → PowerGRYD #4005226", () => {
    assert.equal(
      isDoNotRelinkPair(MAREKBROOKS_EMAIL, POWERGRYD_MAREK_CAMPAIGN_ID),
      true,
    );
    assert.equal(isDoNotRelinkPair(MAREKBROOKS_EMAIL, 4005227), false);
    assert.equal(
      isDoNotRelinkPair("other@meetconnectbox.com", POWERGRYD_MAREK_CAMPAIGN_ID),
      false,
    );
  });

  it("assertAttachAllowedAccountIds rejects the re-link", () => {
    const accountsById = new Map([
      [
        88,
        {
          id: 88,
          from_email: MAREKBROOKS_EMAIL,
          client_id: 592842,
        },
      ],
    ]);
    assert.throws(
      () =>
        assertAttachAllowedAccountIds(POWERGRYD_MAREK_CAMPAIGN_ID, [88], {
          accountsById,
        }),
      AttachForbiddenSeatError,
    );
    assert.doesNotThrow(() =>
      assertAttachAllowedAccountIds(4005227, [88], { accountsById }),
    );
  });
});
