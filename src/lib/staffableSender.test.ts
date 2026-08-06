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

  it("excludes disconnected, held, blocked, and low-inbox senders", () => {
    assert.equal(
      isStaffableSender({ is_smtp_success: false }),
      false,
    );
    assert.equal(isStaffableSender({}, { held: true }), false);
    assert.equal(
      isStaffableSender({
        warmup_details: { is_warmup_blocked: true },
      }),
      false,
    );
    assert.equal(
      isStaffableSender({}, { inboxRate: 40, inboxThreshold: 80 }),
      false,
    );
    // Warmup reputation alone must not under-count live senders.
    assert.equal(
      isStaffableSender({
        warmup_details: { warmup_reputation: 50 },
      }),
      true,
    );
    assert.equal(
      isStaffableSender(
        {
          is_smtp_success: true,
          is_imap_success: true,
          warmup_details: { warmup_reputation: 95 },
        },
        { inboxRate: 90, inboxThreshold: 80 },
      ),
      true,
    );
  });
});
