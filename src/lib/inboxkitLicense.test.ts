import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyInboxkitLicenseSeat,
  classifyInboxkitLicenseSweep,
  formatInboxkitLicenseCleanupSlack,
  groupInboxkitLicenseHandoff,
  inboxkitLicenseIdleReason,
  isPastCancelDate,
} from "./inboxkitLicense.js";

const mondayMorning = new Date("2026-10-05T13:16:00.000Z"); // Monday 8:16am CT
const saturday = new Date("2026-10-03T13:16:00.000Z");
const tuesday = new Date("2026-10-06T13:16:00.000Z");

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

  it("skips disconnected Smartlead accounts and healthy active seats", () => {
    const down = classifyInboxkitLicenseSeat({
      mailbox: { email: "down@x.com", status: "cancelled" },
      account: { id: 5, from_email: "down@x.com", is_smtp_success: false },
      now: mondayMorning,
    });
    assert.deepEqual(down, { skip: "not_connected" });

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

  it("idles on weekends and non-Monday weekdays", () => {
    assert.equal(inboxkitLicenseIdleReason(mondayMorning), undefined);
    assert.match(String(inboxkitLicenseIdleReason(saturday)), /weekend/);
    assert.match(String(inboxkitLicenseIdleReason(tuesday)), /not Monday/);
  });
});
