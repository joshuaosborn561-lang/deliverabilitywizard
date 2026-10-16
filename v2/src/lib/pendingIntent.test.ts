import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isIdenticalPending, payloadReason } from "./pendingIntent.js";

describe("pending intent dedupe", () => {
  it("matches kind + campaign + account + email + payload.reason", () => {
    const existing = {
      kind: "attach" as const,
      campaignId: 1,
      accountId: 9,
      email: "a@x.test",
      payload: { reason: "min40_floor", floor: 40, week: "A" },
      executed: false,
      shadowed: true,
      writeEnabled: false,
    };
    assert.equal(payloadReason(existing.payload), "min40_floor");
    assert.equal(
      isIdenticalPending(existing, {
        kind: "attach",
        campaignId: 1,
        accountId: 9,
        email: "a@x.test",
        payload: { reason: "min40_floor", floor: 30 },
      }),
      true,
    );
    assert.equal(
      isIdenticalPending({ ...existing, executed: true }, {
        kind: "attach",
        campaignId: 1,
        accountId: 9,
        email: "a@x.test",
        payload: { reason: "min40_floor" },
      }),
      false,
    );
  });
});
