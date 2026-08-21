import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractRows,
  parseSenderBounceStats,
  parseSenderRow,
  shouldRotateForBounces,
  shouldWarnForBounces,
} from "./bounceRate.js";

describe("parseSenderRow", () => {
  it("computes the rate from counts", () => {
    const s = parseSenderRow({ email: "a@x.com", sent_count: 200, bounce_count: 14 });
    assert.equal(s?.email, "a@x.com");
    assert.equal(s?.sent, 200);
    assert.ok(Math.abs(s!.bounceRate - 7) < 1e-9);
  });

  it("prefers counts over a reported rate", () => {
    const s = parseSenderRow({
      email: "a@x.com",
      sent: 100,
      bounced: 9,
      bounce_rate: 0,
    });
    assert.equal(s?.bounceRate, 9);
  });

  it("falls back to a reported rate when counts are absent", () => {
    const s = parseSenderRow({ from_email: "b@x.com", bounce_rate: 6.2 });
    assert.equal(s?.bounceRate, 6.2);
    assert.equal(s?.sent, 0);
  });

  it("lowercases the address", () => {
    assert.equal(
      parseSenderRow({ email: "Mixed@X.com", sent: 10, bounced: 1 })?.email,
      "mixed@x.com",
    );
  });

  it("ignores rows with no address or no signal", () => {
    assert.equal(parseSenderRow({ sent: 100, bounced: 5 }), null);
    assert.equal(parseSenderRow({ email: "a@x.com" }), null);
    assert.equal(parseSenderRow({ email: "not-an-address", bounce_rate: 9 }), null);
  });

  it("does not divide by zero on a sender that never sent", () => {
    const s = parseSenderRow({ email: "a@x.com", sent: 0, bounced: 0 });
    assert.equal(s, null);
  });
});

describe("extractRows", () => {
  it("finds rows nested under an envelope", () => {
    const rows = extractRows({
      data: { email_accounts: [{ email: "a@x.com", bounce_rate: 1 }] },
    });
    assert.equal(rows.length, 1);
  });

  it("handles a bare array", () => {
    assert.equal(extractRows([{ email: "a@x.com" }]).length, 1);
  });

  it("returns nothing for an unrecognised payload", () => {
    assert.deepEqual(extractRows({ ok: true }), []);
    assert.deepEqual(extractRows(null), []);
  });
});

describe("parseSenderBounceStats", () => {
  it("keeps the worst reading when an address repeats per campaign", () => {
    const stats = parseSenderBounceStats([
      { email: "a@x.com", sent: 100, bounced: 2 },
      { email: "a@x.com", sent: 100, bounced: 11 },
    ]);
    assert.equal(stats.length, 1);
    assert.equal(stats[0]!.bounceRate, 11);
  });

  it("parses Smartlead name-wise mailbox health metrics", () => {
    // Documented shape from analytics/mailbox/name-wise-health-metrics.
    const stats = parseSenderBounceStats({
      ok: true,
      data: {
        email_health_metrics: [
          {
            email_account: "user@example.com",
            sent: 500,
            opened: 250,
            replied: 30,
            bounced: 5,
          },
        ],
      },
    });
    assert.equal(stats.length, 1);
    assert.equal(stats[0]!.email, "user@example.com");
    assert.equal(stats[0]!.sent, 500);
    assert.ok(Math.abs(stats[0]!.bounceRate - 1) < 1e-9);
  });
});

describe("shouldRotateForBounces", () => {
  it("rotates a sender above the threshold with enough volume", () => {
    assert.equal(
      shouldRotateForBounces({ email: "a@x.com", bounceRate: 7, sent: 200 }, 5, 50),
      true,
    );
  });

  it("leaves a sender at or below the threshold alone", () => {
    assert.equal(
      shouldRotateForBounces({ email: "a@x.com", bounceRate: 5, sent: 200 }, 5, 50),
      false,
    );
  });

  it("ignores a small sample no matter how bad the rate", () => {
    // 1 bounce out of 3 is 33% and means nothing.
    assert.equal(
      shouldRotateForBounces({ email: "a@x.com", bounceRate: 33, sent: 3 }, 5, 50),
      false,
    );
  });
});

describe("shouldWarnForBounces", () => {
  it("warns between 2% and the 5% pull line", () => {
    assert.equal(
      shouldWarnForBounces({ email: "a@x.com", bounceRate: 3, sent: 200 }, 2, 5, 50),
      true,
    );
    assert.equal(
      shouldWarnForBounces({ email: "a@x.com", bounceRate: 1.5, sent: 200 }, 2, 5, 50),
      false,
    );
    assert.equal(
      shouldWarnForBounces({ email: "a@x.com", bounceRate: 6, sent: 200 }, 2, 5, 50),
      false,
    );
  });
});
