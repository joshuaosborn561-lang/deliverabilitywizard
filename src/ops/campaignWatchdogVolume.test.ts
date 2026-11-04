import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseTodayVolume,
  parseWatchdogLeadsLeft,
  WATCHDOG_DAILY_TARGET,
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
});
