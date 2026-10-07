import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyInboxkitLicenseSeat,
  classifyInboxkitLicenseSweep,
  formatInboxkitLicenseCleanupSlack,
  groupInboxkitLicenseHandoff,
  buildInboxkitSeatEnds,
  inboxkitLicenseIdleReason,
  inboxkitMailboxEmail,
  isPastCancelDate,
  seatEndBlocksStaffing,
  seatEndIsLapsed,
} from "./inboxkitLicense.js";

const mondayMorning = new Date("2026-10-05T13:16:00.000Z"); // Monday 8:16am CT
const saturday = new Date("2026-10-03T13:16:00.000Z");
const sunday = new Date("2026-10-04T13:16:00.000Z");
const tuesday = new Date("2026-10-06T13:16:00.000Z");
const friday = new Date("2026-10-09T13:16:00.000Z");

describe("inboxkitLicense classifier (D222/D226)", () => {
  it("flags cancelled / inactive / lapsed seats that are still connected", () => {
    const cancelled = classifyInboxkitLicenseSeat({
      mailbox: { email: "ada@x.com", status: "cancelled", uid: "ik-1" },
      account: { id: 1, from_email: "ada@x.com", client_id: 77, is_smtp_success: true },
      clientName: "TechEvo",
      now: mondayMorning,
    });
    assert.ok("finding" in cancelled);
    assert.equal(cancelled.finding.kind, "still_connected");
    assert.equal(cancelled.finding.clientId, 77);
    assert.equal(cancelled.finding.inboxkitUid, "ik-1");

    const inactive = classifyInboxkitLicenseSeat({
      mailbox: { email: "bob@x.com", status: "inactive" },
      account: { id: 2, from_email: "bob@x.com", is_smtp_success: true },
      now: mondayMorning,
    });
    assert.ok("finding" in inactive);
    assert.equal(inactive.finding.kind, "still_connected");
  });

  it("flags scheduled cancellation with the date and treats a past cancel as lapsed", () => {
    const future = classifyInboxkitLicenseSeat({
      mailbox: {
        email: "soon@x.com",
        status: "scheduled_for_cancellation",
        renewal_date: "2026-11-01",
      },
      account: { id: 3, from_email: "soon@x.com", is_smtp_success: true },
      now: mondayMorning,
    });
    assert.ok("finding" in future);
    assert.equal(future.finding.kind, "scheduled_cancel");
    assert.equal(future.finding.cancelDate, "2026-11-01");

    assert.equal(
      isPastCancelDate(
        { email: "old@x.com", status: "cancelled", cancel_date: "2026-09-01" },
        mondayMorning,
      ),
      true,
    );
    const past = classifyInboxkitLicenseSeat({
      mailbox: {
        email: "old@x.com",
        status: "cancelled",
        cancel_date: "2026-09-01",
      },
      account: { id: 4, from_email: "old@x.com", is_smtp_success: true },
      now: mondayMorning,
    });
    assert.ok("finding" in past);
    assert.equal(past.finding.kind, "still_connected");
    assert.equal(past.finding.cancelDate, "2026-09-01");
  });

  it("D245: a lapsed seat that lost SMTP is still flagged; missing / healthy skip", () => {
    const down = classifyInboxkitLicenseSeat({
      mailbox: { email: "down@x.com", status: "cancelled" },
      account: { id: 5, from_email: "down@x.com", is_smtp_success: false },
      now: mondayMorning,
    });
    assert.ok("finding" in down);
    assert.equal(down.finding.kind, "still_connected");

    const missing = classifyInboxkitLicenseSeat({
      mailbox: { email: "gone@x.com", status: "cancelled" },
      now: mondayMorning,
    });
    assert.deepEqual(missing, { skip: "not_connected" });

    const healthy = classifyInboxkitLicenseSeat({
      mailbox: { email: "ok@x.com", status: "active", renewal_date: "2026-12-01" },
      account: { id: 6, from_email: "ok@x.com", is_smtp_success: true },
      now: mondayMorning,
    });
    assert.deepEqual(healthy, { skip: "healthy" });
  });

  it("groups the handoff per client and only Slacks the cleanup line when X > 0", () => {
    const findings = classifyInboxkitLicenseSweep({
      mailboxes: [
        { email: "ada@x.com", status: "cancelled" },
        {
          email: "soon@x.com",
          status: "scheduled_for_cancellation",
          renewal_date: "2026-11-01",
        },
        { email: "old@x.com", status: "cancelled", cancel_date: "2026-01-01" },
      ],
      accounts: [
        { id: 1, from_email: "ada@x.com", client_id: 77, is_smtp_success: true },
        { id: 2, from_email: "soon@x.com", client_id: 77, is_smtp_success: true },
        { id: 3, from_email: "old@x.com", client_id: 77, is_smtp_success: true },
      ],
      clientNameById: new Map([[77, "TechEvo"]]),
      now: mondayMorning,
    });
    const handoff = groupInboxkitLicenseHandoff(findings);
    assert.equal(handoff.length, 1);
    assert.equal(handoff[0]?.clientName, "TechEvo");
    assert.deepEqual(
      handoff[0]?.stillConnected.map((row) => row.email).sort(),
      ["ada@x.com", "old@x.com"],
    );
    assert.equal(handoff[0]?.upcomingCancellations[0]?.email, "soon@x.com");
    assert.equal(handoff[0]?.upcomingCancellations[0]?.cancelDate, "2026-11-01");
    assert.equal(formatInboxkitLicenseCleanupSlack(0), null);
    assert.equal(
      formatInboxkitLicenseCleanupSlack(2),
      "Found 2 inboxes that had lapsed; they're deleted from Smartlead and InboxKit.",
    );
    assert.doesNotMatch(
      String(formatInboxkitLicenseCleanupSlack(2)),
      /—/,
    );
  });

  it("D245: runs every weekday, idles only on weekends", () => {
    assert.equal(inboxkitLicenseIdleReason(mondayMorning), undefined);
    assert.equal(inboxkitLicenseIdleReason(tuesday), undefined);
    assert.equal(inboxkitLicenseIdleReason(friday), undefined);
    assert.match(String(inboxkitLicenseIdleReason(saturday)), /weekend/);
    assert.match(String(inboxkitLicenseIdleReason(sunday)), /weekend/);
  });
});

// D245 — real InboxKit /v1/api/mailboxes/list row shape (no `email` field).
const latoyaRow = {
  uid: "80d9a72a-d072-476f-b179-7859905f9440",
  username: "latoyaflatley",
  domain_name: "culturefitsaio.info",
  platform: "MICROSOFT",
  status: "scheduled_for_cancellation",
  renewal_date: "2026-09-11T18:22:03.586Z",
  renewal_status: "completed",
  prepaid_until: "2026-06-12T16:59:24.055Z",
  workspaceId: "f5da7ca0-16bd-46cc-a671-1b92ad743c42",
};
const latoyaSl = {
  id: 18696010,
  from_email: "latoyaflatley@culturefitsaio.info",
  client_id: 597783,
  is_smtp_success: true,
  is_imap_success: true,
};
const wednesday = new Date("2026-10-07T13:16:00.000Z"); // Wed 8:16am CT

describe("D245 — latoyaflatley: past scheduled cancel on the real IK row shape", () => {
  it("derives the address from username + domain_name", () => {
    assert.equal(inboxkitMailboxEmail(latoyaRow), "latoyaflatley@culturefitsaio.info");
    assert.equal(inboxkitMailboxEmail({ email: "A@B.com", username: "x", domain_name: "y.com" }), "a@b.com");
  });

  it("flags latoyaflatley as lapsed (still_connected) on 10/5 and 10/7, and deletes it", () => {
    for (const now of [mondayMorning, wednesday]) {
      const findings = classifyInboxkitLicenseSweep({
        mailboxes: [latoyaRow],
        accounts: [latoyaSl],
        clientNameById: new Map([[597783, "Deep Roots Capital"]]),
        now,
      });
      assert.equal(findings.length, 1);
      assert.equal(findings[0]?.kind, "still_connected");
      assert.equal(findings[0]?.email, "latoyaflatley@culturefitsaio.info");
      assert.equal(findings[0]?.slAccountId, 18696010);
      assert.equal(findings[0]?.inboxkitUid, latoyaRow.uid);
      assert.equal(findings[0]?.cancelDate, "2026-09-11T18:22:03.586Z");
    }
  });

  it("the cancel day itself counts as reached (America/Chicago)", () => {
    const row = { ...latoyaRow, renewal_date: "2026-10-07T18:00:00.000Z" };
    assert.equal(isPastCancelDate(row, wednesday), true);
    assert.equal(isPastCancelDate(row, new Date("2026-10-06T13:16:00.000Z")), false);
  });

  it("an ACTIVE row with a stale past renewal_date is not lapsed (domain-level renewal)", () => {
    const raymond = {
      uid: "a378c98e-8b36-40af-90db-5955840e86e0",
      username: "raymondpatel",
      domain_name: "outreachdeskhub.com",
      status: "active",
      renewal_date: "2026-09-24T00:49:56.000Z",
    };
    const out = classifyInboxkitLicenseSweep({
      mailboxes: [raymond],
      accounts: [{ id: 21831356, from_email: "raymondpatel@outreachdeskhub.com", is_smtp_success: true, is_imap_success: true }],
      now: wednesday,
    });
    assert.deepEqual(out, []);
  });

  it("never deletes an address that has a live row in another workspace", () => {
    const out = classifyInboxkitLicenseSweep({
      mailboxes: [
        latoyaRow,
        { ...latoyaRow, uid: "rebuy", status: "active", renewal_date: "2026-11-11T00:00:00.000Z" },
      ],
      accounts: [latoyaSl],
      now: wednesday,
    });
    assert.deepEqual(out, []);
  });

  it("seat ends: lapsed now and staffing blocked; a cancel 5 days out blocks staffing, 10 days does not", () => {
    const ends = buildInboxkitSeatEnds([
      latoyaRow,
      { username: "soon", domain_name: "x.info", status: "scheduled_for_cancellation", renewal_date: "2026-10-12T00:00:00.000Z" },
      { username: "later", domain_name: "x.info", status: "scheduled_for_cancellation", renewal_date: "2026-10-17T12:00:00.000Z" },
      { username: "fine", domain_name: "x.info", status: "active", renewal_date: "2026-09-01T00:00:00.000Z" },
    ]);
    const latoya = ends["latoyaflatley@culturefitsaio.info"];
    assert.equal(seatEndIsLapsed(latoya, wednesday), true);
    assert.equal(seatEndBlocksStaffing(latoya, wednesday), true);
    assert.equal(seatEndIsLapsed(ends["soon@x.info"], wednesday), false);
    assert.equal(seatEndBlocksStaffing(ends["soon@x.info"], wednesday), true);
    assert.equal(seatEndBlocksStaffing(ends["later@x.info"], wednesday), false);
    assert.equal(ends["fine@x.info"], undefined);
  });
});
