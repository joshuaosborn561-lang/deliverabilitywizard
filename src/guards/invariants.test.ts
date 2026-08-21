import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { StateStore } from "../state/store.js";
import { classifyDomain, isCritical } from "../services/dnsAudit.js";
import { parseSenderRow } from "../lib/bounceRate.js";

/**
 * Safety rules anyone working here should keep. Each corresponds to a real
 * failure this repo has had in production.
 */

function store(): StateStore {
  // No path is written during these tests; nothing here calls save().
  return new StateStore("/tmp/guard-state.json");
}

describe("invariants", () => {
  it("a warming mailbox is never handed out before its clock expires", () => {
    // Production: 202 mailboxes registered, only the pre-warmed ones usable.
    const s = store();
    s.upsertPoolMailbox({
      email: "cold@pool.info",
      domain: "pool.info",
      platform: "GOOGLE",
      smartleadAccountId: 1,
      firstName: "Cold",
      lastName: "Mailbox",
      status: "warming",
      warmedAt: new Date().toISOString(),
    });

    assert.equal(
      s.findAvailablePoolMailbox("GOOGLE"),
      undefined,
      "a mailbox still warming must not be selectable for a live campaign",
    );

    const flipped = s.refreshPoolAvailability(14);
    assert.equal(flipped, 0, "a clock started today cannot have served 14 days");
    assert.equal(s.findAvailablePoolMailbox("GOOGLE"), undefined);
  });

  it("a mailbox becomes available once its warmup has actually elapsed", () => {
    const s = store();
    s.upsertPoolMailbox({
      email: "warm@pool.info",
      domain: "pool.info",
      platform: "GOOGLE",
      smartleadAccountId: 2,
      firstName: "Warm",
      lastName: "Mailbox",
      status: "warming",
      warmedAt: new Date(Date.now() - 15 * 86_400_000).toISOString(),
    });
    assert.equal(s.refreshPoolAvailability(14), 1);
    assert.equal(s.findAvailablePoolMailbox("GOOGLE")?.email, "warm@pool.info");
  });

  it("a resting generic is never handed out for top-up or recovery (D42)", () => {
    const s = store();
    s.upsertPoolMailbox({
      email: "resting@pool.info",
      domain: "pool.info",
      platform: "GOOGLE",
      smartleadAccountId: 99,
      firstName: "Rest",
      lastName: "Ing",
      status: "available",
      warmedAt: "2020-01-01T00:00:00.000Z",
      availableAt: "2020-01-15T00:00:00.000Z",
    });
    s.markRestingInbox({
      accountId: 99,
      email: "resting@pool.info",
      clientId: "unknown",
      cohort: "A",
      restingSince: "2026-08-01T00:00:00.000Z",
      removedFromCampaigns: [],
      lastSameEspInbox: null,
    });
    assert.equal(
      s.findAvailablePoolMailbox("GOOGLE"),
      undefined,
      "a resting generic must not be recovery supply",
    );
    assert.equal(
      s.findReassignablePoolMailbox(["GOOGLE"], () => true),
      undefined,
      "a resting generic must not be top-up supply",
    );
  });

  it("an ESP mismatch never yields a mailbox", () => {
    const s = store();
    s.upsertPoolMailbox({
      email: "g@pool.info",
      domain: "pool.info",
      platform: "GOOGLE",
      smartleadAccountId: 3,
      firstName: "G",
      lastName: "User",
      status: "available",
    });
    assert.equal(
      s.findAvailablePoolMailbox("MICROSOFT"),
      undefined,
      "a Google mailbox must not be returned for a Microsoft request",
    );
  });

  it("a domain with no SPF record is treated as critical", () => {
    // Production: five parlaytech domains published DMARC with no SPF at all.
    const audit = classifyDomain("parlaytechnow.info", 3, {
      txt: [],
      dmarc: ["v=DMARC1; p=reject"],
      mx: ["x.mail.protection.outlook.com"],
    });
    assert.ok(audit.issues.includes("no-spf"));
    assert.equal(
      isCritical(audit),
      true,
      "a sending domain with no SPF must alert, not be reported quietly",
    );
  });

  it("a transient DNS failure is not read as a missing record", () => {
    const audit = classifyDomain("blip.info", 1, {
      txt: null,
      dmarc: null,
      mx: null,
    });
    assert.deepEqual(
      audit.issues,
      ["unresolvable"],
      "an unresolvable lookup must not be reported as no-spf/no-dmarc/no-mx",
    );
  });

  it("a bounce rate is never computed from a zero denominator", () => {
    assert.equal(
      parseSenderRow({ email: "a@x.com", sent: 0, bounced: 0 }),
      null,
      "a sender that has not sent must yield no bounce signal",
    );
  });
});
