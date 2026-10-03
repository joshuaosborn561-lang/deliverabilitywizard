import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EVIDENCE_HOLD_MAX_DAYS,
  EVIDENCE_HOLD_WARMUP_DAYS,
  EVIDENCE_HOLD_WARMUP_REPUTATION_THRESHOLD,
  applyGuardedHoldRequest,
  evidenceHoldReasonCleared,
  evidenceHoldStillActive,
  gateSeatHolds,
  holdExpiresAt,
  holdUntilTagName,
  persistAcceptedHolds,
  rejectedHoldSlackText,
  type EvidenceHoldRecord,
  type SeatHoldRequest,
} from "./evidenceHold.js";

const NOW = new Date("2026-09-28T16:00:00.000Z");

function bounceSeat(
  email: string,
  extra: Partial<SeatHoldRequest> = {},
): SeatHoldRequest {
  return {
    email,
    accountId: extra.accountId ?? 1,
    reason: "hard_bounce_or_block",
    evidence: {
      eventId: "evt-233-1",
      smtpCode: "5.7.233",
      tenant: email.split("@")[1],
      ...extra.evidence,
    },
    source: extra.source ?? "test",
    ...extra,
  };
}

describe("D224 evidence-per-seat hold gate", () => {
  it("holds a seat with its own hard bounce event id and SMTP code", () => {
    const gated = gateSeatHolds(
      [bounceSeat("ada@salesglider.com", { accountId: 10 })],
      { now: NOW },
    );
    assert.equal(gated.rejected.length, 0);
    assert.equal(gated.accepted.length, 1);
    assert.equal(gated.accepted[0]!.reason, "hard_bounce_or_block");
    assert.equal(gated.accepted[0]!.evidence.eventId, "evt-233-1");
    assert.equal(gated.accepted[0]!.domain, "salesglider.com");
  });

  it("rejects a bounce hold without the event id or SMTP code", () => {
    const gated = gateSeatHolds(
      [
        {
          email: "ada@salesglider.com",
          reason: "hard_bounce_or_block",
          evidence: { smtpCode: "5.7.233" },
        },
        {
          email: "casey@salesglider.com",
          reason: "hard_bounce_or_block",
          evidence: { eventId: "evt-1" },
        },
      ],
      { now: NOW },
    );
    assert.equal(gated.accepted.length, 0);
    assert.equal(gated.rejected.length, 2);
    assert.match(gated.rejected[0]!.rejectReason, /event id/);
    assert.match(gated.rejected[1]!.rejectReason, /SMTP code/);
  });

  it("holds SMTP or IMAP auth failure on that account", () => {
    const gated = gateSeatHolds(
      [
        {
          email: "ada@salesglider.com",
          reason: "auth_failure",
          evidence: { authKind: "smtp" },
        },
        {
          email: "casey@salesglider.com",
          reason: "auth_failure",
          evidence: { authKind: "imap" },
        },
        {
          email: "lee@salesglider.com",
          reason: "auth_failure",
          evidence: {},
        },
      ],
      { now: NOW },
    );
    assert.deepEqual(
      gated.accepted.map((row) => row.email),
      ["ada@salesglider.com", "casey@salesglider.com"],
    );
    assert.equal(gated.rejected[0]!.email, "lee@salesglider.com");
  });

  it("holds only an exact retired or bad-sender domain", () => {
    const gated = gateSeatHolds(
      [
        {
          email: "a@getboldercyperpartner.info",
          reason: "retired_or_bad_sender_domain",
          evidence: { domain: "getboldercyperpartner.info" },
        },
        {
          email: "b@boldercyperpartner.com",
          reason: "retired_or_bad_sender_domain",
          evidence: { domain: "boldercyperpartner.com" },
        },
      ],
      {
        now: NOW,
        retiredDomains: ["getboldercyperpartner.info"],
      },
    );
    assert.deepEqual(
      gated.accepted.map((row) => row.email),
      ["a@getboldercyperpartner.info"],
    );
    assert.match(gated.rejected[0]!.rejectReason, /not retired/);
  });

  it("holds an InboxKit lapsed, cancelled, or inactive seat and rejects others", () => {
    const gated = gateSeatHolds(
      [
        {
          email: "a@x.com",
          reason: "inboxkit_lapsed",
          evidence: { inboxkitStatus: "lapsed" },
        },
        {
          email: "b@x.com",
          reason: "inboxkit_lapsed",
          evidence: { inboxkitStatus: "cancelled" },
        },
        {
          email: "c@x.com",
          reason: "inboxkit_lapsed",
          evidence: { inboxkitStatus: "inactive" },
        },
        {
          email: "d@x.com",
          reason: "inboxkit_lapsed",
          evidence: { inboxkitStatus: "active" },
        },
      ],
      { now: NOW },
    );
    assert.equal(gated.accepted.length, 3);
    assert.equal(gated.rejected[0]!.email, "d@x.com");
  });

  it("holds a named blacklist hit and refuses SURBL", () => {
    const gated = gateSeatHolds(
      [
        {
          email: "a@x.com",
          reason: "blacklist_hit",
          evidence: { blacklistList: "Spamhaus", domain: "x.com" },
        },
        {
          email: "b@y.com",
          reason: "blacklist_hit",
          evidence: { blacklistList: "multi.surbl.org", domain: "y.com" },
        },
      ],
      { now: NOW },
    );
    assert.equal(gated.accepted[0]!.email, "a@x.com");
    assert.match(gated.rejected[0]!.rejectReason, /SURBL/);
  });

  it("holds warmup under 21 days or reputation below threshold", () => {
    const gated = gateSeatHolds(
      [
        {
          email: "a@x.com",
          reason: "warmup_short_or_low_rep",
          evidence: { warmupDays: 12 },
        },
        {
          email: "b@x.com",
          reason: "warmup_short_or_low_rep",
          evidence: {
            warmupDays: 40,
            warmupReputation: EVIDENCE_HOLD_WARMUP_REPUTATION_THRESHOLD - 1,
          },
        },
        {
          email: "c@x.com",
          reason: "warmup_short_or_low_rep",
          evidence: {
            warmupDays: EVIDENCE_HOLD_WARMUP_DAYS,
            warmupReputation: EVIDENCE_HOLD_WARMUP_REPUTATION_THRESHOLD,
          },
        },
      ],
      { now: NOW },
    );
    assert.deepEqual(
      gated.accepted.map((row) => row.email),
      ["a@x.com", "b@x.com"],
    );
    assert.equal(gated.rejected[0]!.email, "c@x.com");
  });

  it("refuses substring, pattern, and client matches", () => {
    const gated = gateSeatHolds(
      [
        {
          email: "a@boldercyperpartner.com",
          reason: "retired_or_bad_sender_domain",
          matchKind: "substring",
          evidence: { domain: "boldercyperpartner.com", pattern: "boldercyper" },
        },
        {
          email: "b@boldercyperpartner.com",
          reason: "retired_or_bad_sender_domain",
          matchKind: "pattern",
          evidence: { domain: "boldercyper*" },
        },
        {
          email: "c@boldercyperpartner.com",
          reason: "retired_or_bad_sender_domain",
          matchKind: "client",
          evidence: { domain: "boldercyperpartner.com" },
        },
      ],
      {
        now: NOW,
        retiredDomains: ["boldercyperpartner.com"],
      },
    );
    assert.equal(gated.accepted.length, 0);
    assert.equal(gated.rejected.length, 3);
  });

  it("caps expiry at 30 days and writes a HOLD-UNTIL tag for that day", () => {
    const far = holdExpiresAt(NOW, "2027-12-31");
    assert.equal(
      Math.round((far.getTime() - NOW.getTime()) / 86_400_000),
      EVIDENCE_HOLD_MAX_DAYS,
    );
    assert.equal(holdUntilTagName(far), "HOLD-UNTIL-2026-10-28");

    const gated = gateSeatHolds(
      [
        bounceSeat("ada@salesglider.com", {
          expiresAt: "2027-01-01",
        }),
      ],
      { now: NOW },
    );
    assert.equal(gated.accepted[0]!.expiresAt, far.toISOString());
    assert.equal(gated.accepted[0]!.tagName, "HOLD-UNTIL-2026-10-28");
    assert.equal(evidenceHoldStillActive(gated.accepted[0]!, NOW), true);
    assert.equal(
      evidenceHoldStillActive(gated.accepted[0]!, new Date("2026-10-29T00:00:00.000Z")),
      false,
    );
  });

  it("clears a retired-domain hold when that exact domain is no longer retired", () => {
    const record: EvidenceHoldRecord = {
      email: "a@getboldercyperpartner.info",
      domain: "getboldercyperpartner.info",
      reason: "retired_or_bad_sender_domain",
      evidence: { domain: "getboldercyperpartner.info" },
      heldAt: NOW.toISOString(),
      expiresAt: holdExpiresAt(NOW).toISOString(),
      source: "test",
      tagName: "HOLD-UNTIL-2026-10-28",
    };
    assert.equal(
      evidenceHoldReasonCleared(record, {
        retiredDomains: ["getboldercyperpartner.info"],
      }),
      false,
    );
    assert.equal(evidenceHoldReasonCleared(record, { retiredDomains: [] }), true);
  });

  it("replays 9/28: 97 boldercyper seats, hold only getbold/keybold, reject 87", () => {
    const retired = ["getboldercyperpartner.info", "keyboldercyperpartner.info"];
    const seats: SeatHoldRequest[] = [];

    for (let i = 1; i <= 5; i += 1) {
      seats.push({
        email: `get${i}@getboldercyperpartner.info`,
        accountId: 1000 + i,
        reason: "retired_or_bad_sender_domain",
        evidence: { domain: "getboldercyperpartner.info" },
        expiresAt: "2027-01-01",
        source: "canon-qa-2026-09-28",
      });
    }
    for (let i = 1; i <= 5; i += 1) {
      seats.push({
        email: `key${i}@keyboldercyperpartner.info`,
        accountId: 2000 + i,
        reason: "retired_or_bad_sender_domain",
        evidence: { domain: "keyboldercyperpartner.info" },
        expiresAt: "2027-01-01",
        source: "canon-qa-2026-09-28",
      });
    }
    for (let i = 1; i <= 87; i += 1) {
      seats.push({
        email: `seat${i}@boldercyperpartner${i}.info`,
        accountId: 3000 + i,
        reason: "retired_or_bad_sender_domain",
        matchKind: "substring",
        evidence: {
          domain: `boldercyperpartner${i}.info`,
          pattern: "boldercyper",
        },
        expiresAt: "2027-01-01",
        source: "canon-qa-2026-09-28",
      });
    }

    assert.equal(seats.length, 97);
    const gated = gateSeatHolds(seats, { now: NOW, retiredDomains: retired });
    assert.equal(gated.accepted.length, 10);
    assert.equal(gated.rejected.length, 87);
    assert.ok(
      gated.accepted.every(
        (row) =>
          row.domain === "getboldercyperpartner.info" ||
          row.domain === "keyboldercyperpartner.info",
      ),
    );
    assert.ok(
      gated.rejected.every((row) => row.email.includes("boldercyperpartner")),
    );
    assert.ok(
      gated.accepted.every((row) => row.expiresAt.startsWith("2026-10-28")),
    );

    const slack = rejectedHoldSlackText(gated.rejected);
    assert.ok(slack);
    assert.match(slack, /Hold gate rejected 87 seats/);
    assert.equal(slack.includes("\u2014"), false, "no em dash in the Slack note");
    assert.match(slack, /seat1@boldercyperpartner1\.info/);
    assert.match(slack, /seat87@boldercyperpartner87\.info/);
    assert.equal(slack.includes("get1@getboldercyperpartner.info"), false);
  });

  it("persists reason and evidence, and posts one rejected-seat Slack note", async () => {
    const holds: EvidenceHoldRecord[] = [];
    const notes: string[] = [];
    const gated = await applyGuardedHoldRequest({
      seats: [
        bounceSeat("ada@salesglider.com", { accountId: 10 }),
        {
          email: "lee@boldercyperpartner.com",
          reason: "retired_or_bad_sender_domain",
          matchKind: "substring",
          evidence: { domain: "boldercyperpartner.com", pattern: "boldercyper" },
        },
      ],
      store: {
        upsertEvidenceHold(record) {
          holds.push(record);
        },
      },
      slack: {
        notifyDeliverabilityNote: async (text) => {
          notes.push(text);
        },
      },
      context: { now: NOW },
    });

    assert.equal(gated.accepted.length, 1);
    assert.equal(holds[0]!.reason, "hard_bounce_or_block");
    assert.equal(holds[0]!.evidence.eventId, "evt-233-1");
    assert.equal(notes.length, 1);
    assert.match(notes[0]!, /lee@boldercyperpartner\.com/);
  });

  it("writes bounce and TERRL lists only for gated 5.7.233 seats", () => {
    const bounceIds: number[] = [];
    const terl: Array<{ tenant: string; accountIds: number[] }> = [];
    persistAcceptedHolds(
      {
        upsertEvidenceHold() {},
        ensureBounceHold(ids) {
          bounceIds.push(...ids);
        },
        ensureTenantTerlHold(input) {
          terl.push({
            tenant: String(input.tenant),
            accountIds: [...(input.accountIds ?? [])],
          });
        },
      },
      gateSeatHolds(
        [bounceSeat("ada@salesglider.com", { accountId: 10 })],
        { now: NOW },
      ).accepted,
      NOW,
    );
    assert.deepEqual(bounceIds, [10]);
    assert.deepEqual(terl, [{ tenant: "salesglider.com", accountIds: [10] }]);
  });
});
