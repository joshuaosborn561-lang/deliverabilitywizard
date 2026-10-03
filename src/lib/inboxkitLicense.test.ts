import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyInboxkitLicenseSeat,
  classifyInboxkitLicenseSweep,
  formatInboxkitLicenseSlack,
  inboxkitLicenseIdleReason,
  isPastCancelDate,
} from "./inboxkitLicense.js";

const mondayMorning = new Date("2026-10-05T13:16:00.000Z"); // Monday 8:16am CT
const saturday = new Date("2026-10-03T13:16:00.000Z");
const tuesday = new Date("2026-10-06T13:16:00.000Z");

describe("inboxkitLicense classifier (D222)", () => {
  it("flags cancelled / inactive / lapsed seats that are still connected", () => {
    const cancelled = classifyInboxkitLicenseSeat({
      mailbox: { email: "ada@x.com", status: "cancelled" },
      account: { id: 1, from_email: "ada@x.com", client_id: 77, is_smtp_success: true },
      clientName: "TechEvo",
      now: mondayMorning,
    });
    assert.ok("finding" in cancelled);
    assert.equal(cancelled.finding.kind, "still_connected");
    assert.equal(cancelled.finding.clientId, 77);

    const inactive = classifyInboxkitLicenseSeat({
      mailbox: { email: "bob@x.com", status: "inactive" },
      account: { id: 2, from_email: "bob@x.com", is_smtp_success: true },
      now: mondayMorning,
    });
    assert.ok("finding" in inactive);
    assert.equal(inactive.finding.kind, "still_connected");
  });

  it("flags scheduled cancellation with the date and skips a past cancel date", () => {
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
    assert.deepEqual(past, { skip: "past_cancel_onboarding" });
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

  it("groups Slack per client and never uses an em dash", () => {
    const text = formatInboxkitLicenseSlack(
      classifyInboxkitLicenseSweep({
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
      }),
    );
    assert.ok(text);
    assert.match(text, /\*TechEvo\* \(77\)/);
    assert.match(text, /ada@x.com InboxKit cancelled/);
    assert.match(text, /soon@x.com on 2026-11-01/);
    assert.doesNotMatch(text, /old@x.com/);
    assert.doesNotMatch(text, /—/);
    assert.match(text, /No deletes and no unlinks/);
  });

  it("idles on weekends and non-Monday weekdays", () => {
    assert.equal(inboxkitLicenseIdleReason(mondayMorning), undefined);
    assert.match(String(inboxkitLicenseIdleReason(saturday)), /weekend/);
    assert.match(String(inboxkitLicenseIdleReason(tuesday)), /not Monday/);
  });
});
