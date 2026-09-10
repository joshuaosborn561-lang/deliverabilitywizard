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
    assert.equal(mailboxMessagePerDayTarget({ type: "OUTLOOK" }, config), 15);
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
});
