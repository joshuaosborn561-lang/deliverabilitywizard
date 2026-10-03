import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  OUTLOOK_MESSAGE_PER_DAY,
  mailboxMessagePerDayTarget,
  totalDailySendCeiling,
} from "./sendCeiling.js";

const config = { messagePerDay: 30, warmupTotalPerDay: 20 };

describe("totalDailySendCeiling", () => {
  it("is the campaign Message Per Day field (warmups not included)", () => {
    assert.equal(totalDailySendCeiling(config), 30);
  });
});

describe("mailboxMessagePerDayTarget (D183)", () => {
  it("Outlook / Microsoft types target 15; Gmail and SMTP stay at MESSAGE_PER_DAY", () => {
    assert.equal(OUTLOOK_MESSAGE_PER_DAY, 15);
    assert.equal(
      mailboxMessagePerDayTarget(
        { type: "OUTLOOK", from_email: "ada@salesglider.com" },
        config,
      ),
      15,
    );
    assert.equal(mailboxMessagePerDayTarget({ type: "MICROSOFT" }, config), 15);
    assert.equal(mailboxMessagePerDayTarget({ type: "OFFICE365" }, config), 15);
    assert.equal(mailboxMessagePerDayTarget({ platform: "MICROSOFT" }, config), 15);
    assert.equal(mailboxMessagePerDayTarget({ type: "GMAIL" }, config), 30);
    assert.equal(mailboxMessagePerDayTarget({ type: "SMTP" }, config), 30);
    assert.equal(mailboxMessagePerDayTarget({ type: "GOOGLE" }, config), 30);
    assert.equal(mailboxMessagePerDayTarget({ platform: "GOOGLE" }, config), 30);
    assert.equal(mailboxMessagePerDayTarget({}, config), 30);
    assert.equal(mailboxMessagePerDayTarget(null, config), 30);
  });

  it("does not follow a lowered MESSAGE_PER_DAY for Outlook", () => {
    assert.equal(
      mailboxMessagePerDayTarget({ type: "OUTLOOK" }, { messagePerDay: 20 }),
      15,
    );
    assert.equal(
      mailboxMessagePerDayTarget({ type: "GMAIL" }, { messagePerDay: 20 }),
      20,
    );
  });

  it("D219: Azure domain is 2; a live TERRL hold is 0 then the type cap", () => {
    const azure = {
      id: 9,
      type: "OUTLOOK" as const,
      from_email: "ada@tidalstackco.com",
    };
    assert.equal(mailboxMessagePerDayTarget(azure, config), 2);
    const m365 = {
      id: 9,
      type: "OUTLOOK" as const,
      from_email: "ada@salesglider.com",
    };
    const now = new Date("2026-10-03T15:00:00.000Z");
    const store = {
      isTenantTerlHoldAccount: (id: number) => id === 9,
      isTenantTerlHoldDomain: (domain: string) => domain === "salesglider.com",
    };
    assert.equal(mailboxMessagePerDayTarget(m365, config, store, now), 0);
    const after = new Date("2026-10-04T16:00:00.000Z");
    const expired = {
      isTenantTerlHoldAccount: () => false,
      isTenantTerlHoldDomain: () => false,
    };
    assert.equal(mailboxMessagePerDayTarget(m365, config, expired, after), 15);
    assert.equal(mailboxMessagePerDayTarget(azure, config, expired, after), 2);
  });
});
