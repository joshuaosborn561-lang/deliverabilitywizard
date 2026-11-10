import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseTodayVolume,
  parseWatchdogLeadsLeft,
  WATCHDOG_DAILY_TARGET,
  WATCHDOG_TIMEZONE,
  ymdInZone,
} from "./campaignWatchdogVolume.js";

describe("campaign watchdog volume", () => {
  it("uses the dated row for today and ignores lifetime sent_count", () => {
    const volume = parseTodayVolume(
      {
        sent_count: 5328,
        data: [
          { date: "2026-11-03", sent_count: 900, bounce_count: 4 },
          { date: "2026-11-04", sent_count: 0, bounce_count: 0 },
        ],
      },
      "2026-11-04",
    );
    assert.equal(volume.sent, 0);
    assert.equal(volume.bounced, 0);
  });

  it("reads a flat dated sent_count when Smartlead returns no day array", () => {
    assert.equal(parseTodayVolume({ sent_count: "180" }, "2026-11-04").sent, 180);
  });

  it("counts leads left as not started plus in progress", () => {
    assert.equal(
      parseWatchdogLeadsLeft({
        total_leads: 800,
        campaign_lead_stats: { total: 800, notStarted: 200, inprogress: 50 },
      }),
      250,
    );
  });

  it("does not use mailbox caps as the pace target", () => {
    assert.equal(WATCHDOG_DAILY_TARGET, 1200);
  });

  // Shapes captured from Smartlead 2026-11-10 (campaign 4453079, scrubbed).
  const liveByDate = {
    id: 4453079, status: "ACTIVE", start_date: "2026-11-10", end_date: "2026-11-10",
    sent_count: "31", unique_sent_count: "31", bounce_count: "0",
    total_count: "214", drafted_count: "183",
  };
  const liveAnalytics = {
    id: 4453079, status: "ACTIVE", sent_count: "31", total_count: "214",
    sequence_count: "2", drafted_count: "183", unique_sent_count: "31", client_id: 602897,
    campaign_lead_stats: {
      total: 107, paused: 0, blocked: 0, revenue: 0, stopped: 0,
      completed: 0, inprogress: 31, interested: 0, notStarted: 76,
    },
  };

  it("reads the live flat analytics-by-date body as that day's sends", () => {
    assert.equal(parseTodayVolume(liveByDate, "2026-11-10").sent, 31);
  });

  it("counts leads, not messages: lead stats win over total_count / drafted_count", () => {
    // total_count (214) is leads x steps and drafted_count (183) is
    // messages still to send; neither is leads left.
    assert.equal(parseWatchdogLeadsLeft(liveAnalytics), 107);
  });

  it("an ACTIVE campaign with zero leads has 0 left, not unread", () => {
    assert.equal(
      parseWatchdogLeadsLeft({
        total_count: "0",
        campaign_lead_stats: { total: 0, inprogress: 0, notStarted: 0, completed: 0 },
      }),
      0,
    );
    assert.equal(parseWatchdogLeadsLeft({ total_count: "0", drafted_count: "0" }), null);
    assert.equal(parseWatchdogLeadsLeft({ total_count: "214", drafted_count: "183" }), null);
  });

  it("counts the send day in Eastern, the campaigns' scheduler timezone (D327)", () => {
    assert.equal(WATCHDOG_TIMEZONE, "America/New_York");
    // 23:30 Central on Nov 10 is already Nov 11 in Eastern.
    assert.equal(ymdInZone(new Date("2026-11-11T05:30:00.000Z")), "2026-11-11");
    assert.equal(ymdInZone(new Date("2026-11-11T05:30:00.000Z"), "America/Chicago"), "2026-11-10");
  });
});

