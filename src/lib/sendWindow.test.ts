import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canonSchedulePayload, readCampaignSchedule, scheduleOnCanon } from "./sendWindow.js";

describe("D303 send-window converge", () => {
  it("reads Smartlead scheduler_cron_value and detects canon", () => {
    const s = readCampaignSchedule({
      scheduler_cron_value: { tz: "America/New_York", days: [1, 2, 3, 4], startHour: "08:00", endHour: "19:00" },
      min_time_btwn_emails: 10,
      max_leads_per_day: 10000,
    });
    assert.equal(scheduleOnCanon(s), true);
  });
  it("off-window campaigns get a payload that keeps their gap and cap", () => {
    const s = readCampaignSchedule({
      scheduler_cron_value: { tz: "America/Chicago", days: [1, 2, 3, 4, 5], startHour: "09:00", endHour: "18:00" },
      min_time_btwn_emails: 10,
      max_leads_per_day: 500,
    });
    assert.equal(scheduleOnCanon(s), false);
    assert.deepEqual(canonSchedulePayload(s), {
      timezone: "America/New_York",
      days_of_the_week: [1, 2, 3, 4],
      start_hour: "08:00",
      end_hour: "19:00",
      min_time_btw_emails: 10,
      max_new_leads_per_day: 500,
    });
  });
  it("never guesses an unknown gap or cap", () => {
    assert.equal(canonSchedulePayload(readCampaignSchedule({})), null);
  });
});
