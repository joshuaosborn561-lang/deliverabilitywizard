import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  calendarDateInTimeZone,
  dayBounceRatePercent,
  goliathSiblingKey,
  isGoliathCampaign,
  shouldTripDayBounce,
} from "./dayBounce.js";
import {
  diagnoseDayBounce,
  diagnosisLabel,
} from "./dayBounceDiagnosis.js";

describe("dayBounce", () => {
  it("computes day bounce rate and trips only after min sample", () => {
    assert.equal(dayBounceRatePercent(100, 8), 8);
    assert.equal(
      shouldTripDayBounce({
        sent: 40,
        bounced: 10,
        thresholdPercent: 7,
        minSent: 50,
      }),
      false,
    );
    assert.equal(
      shouldTripDayBounce({
        sent: 100,
        bounced: 8,
        thresholdPercent: 7,
        minSent: 50,
      }),
      true,
    );
    assert.equal(
      shouldTripDayBounce({
        sent: 100,
        bounced: 7,
        thresholdPercent: 7,
        minSent: 50,
      }),
      false,
    );
  });

  it("matches Goliath by name or client id", () => {
    assert.equal(
      isGoliathCampaign({ name: "Goliath L1 Tickets", client_id: 1 }, 548611),
      true,
    );
    assert.equal(
      isGoliathCampaign({ name: "Other", client_id: 548611 }, 548611),
      true,
    );
    assert.equal(
      isGoliathCampaign({ name: "Other", client_id: 1 }, 548611),
      false,
    );
  });

  it("sibling key strips offer words", () => {
    assert.equal(
      goliathSiblingKey("Goliath L1 Financial Services AirPods"),
      goliathSiblingKey("Goliath L1 Financial Services Tickets"),
    );
  });

  it("formats a Chicago calendar date", () => {
    // 2026-08-13 05:30 UTC is still Aug 13 evening? 05:30 UTC = Aug 13 00:30 CDT
    const d = calendarDateInTimeZone(
      "America/Chicago",
      new Date("2026-08-13T05:30:00.000Z"),
    );
    assert.equal(d, "2026-08-13");
  });
});

describe("dayBounceDiagnosis", () => {
  it("flags AirPods vs Tickets sibling as spam/copy", () => {
    const d = diagnoseDayBounce({
      campaignName: "Goliath L1 Financial Services AirPods",
      dayRate: 18,
      categories: { none: 10 },
      siblings: [
        {
          campaignId: 1,
          name: "Goliath L1 Financial Services Tickets",
          sent: 200,
          bounced: 10,
          rate: 5,
        },
      ],
      sequenceSubject: "small thank you",
      sequenceBodyPlain: "Got a pair of AirPods on me",
    });
    assert.equal(d.primary, "spam_or_copy");
    assert.ok(d.reasons.some((r) => /AirPods offer|spam-filter bait/i.test(r)));
  });

  it("flags sender-originated majority as delays/reputation", () => {
    const d = diagnoseDayBounce({
      campaignName: "Goliath L2 Healthcare Tickets",
      dayRate: 12,
      categories: { "Sender Originated Bounce": 40, none: 5 },
      siblings: [],
    });
    assert.equal(d.primary, "delays_or_sender_reputation");
    assert.match(diagnosisLabel(d.primary), /Delays/i);
  });

  it("flags many hot mailboxes as rotation", () => {
    const d = diagnoseDayBounce({
      campaignName: "Goliath L3 Manufacturing Defense Tickets",
      dayRate: 10,
      categories: { none: 20 },
      siblings: [],
      hotMailboxes: [
        { email: "a@x.com", bounceRate: 15, sent: 40 },
        { email: "b@x.com", bounceRate: 12, sent: 40 },
        { email: "c@x.com", bounceRate: 11, sent: 40 },
      ],
    });
    assert.equal(d.primary, "mailbox_rotation");
  });
});
