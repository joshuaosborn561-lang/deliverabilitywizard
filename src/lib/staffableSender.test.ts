import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isConnectedAccount,
  isStaffableSender,
  parseWarmupReputation,
} from "./staffableSender.js";

describe("staffableSender", () => {
  it("treats unknown smtp/imap as connected", () => {
    assert.equal(isConnectedAccount({}), true);
    assert.equal(
      isConnectedAccount({ is_smtp_success: true, is_imap_success: true }),
      true,
    );
    assert.equal(isConnectedAccount({ is_smtp_success: false }), false);
    assert.equal(isConnectedAccount({ is_imap_success: false }), false);
  });

  it("parses warmup reputation from number or percent string", () => {
    assert.equal(
      parseWarmupReputation({ warmup_details: { warmup_reputation: 92 } }),
      92,
    );
    assert.equal(
      parseWarmupReputation({ warmup_details: { warmup_reputation: "71%" } }),
      71,
    );
    assert.equal(parseWarmupReputation({ warmup_details: null }), null);
  });

  it("excludes disconnected, resting, canary, and warmup-blocked senders", () => {
    assert.equal(
      isStaffableSender({ is_smtp_success: false }),
      false,
    );
    assert.equal(isStaffableSender({}, { resting: true }), false);
    assert.equal(isStaffableSender({}, { copyCanary: true }), false);
    assert.equal(
      isStaffableSender({
        warmup_details: { is_warmup_blocked: true },
      }),
      false,
    );
    // Warmup reputation alone must not under-count live senders.
    assert.equal(
      isStaffableSender({
        warmup_details: { warmup_reputation: 50 },
      }),
      true,
    );
    // D130 — kill-only: a connected, non-resting, non-canary inbox staffs.
    // There is no placement-rate bar and no held tier here any more.
    assert.equal(
      isStaffableSender({
        is_smtp_success: true,
        is_imap_success: true,
        warmup_details: { warmup_reputation: 95 },
      }),
      true,
    );
  });
});
