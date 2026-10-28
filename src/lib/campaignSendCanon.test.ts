import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  convergeSendCanon,
  sendCanonDrift,
  sendCanonScheduleBody,
  type SendCanonCampaign,
} from "./campaignSendCanon.js";

const cron = { tz: "America/New_York", days: [1, 2, 3, 4], startHour: "08:00", endHour: "19:00" };

function writer() {
  const calls: Array<[string, number, Record<string, unknown>]> = [];
  return {
    calls,
    async updateCampaignSettings(id: number, body: Record<string, unknown>) {
      calls.push(["settings", id, body]);
    },
    async updateCampaignSchedule(id: number, body: Record<string, unknown>) {
      calls.push(["schedule", id, body]);
    },
  };
}

describe("D304 send canon (ESP matching ON + 10m gap)", () => {
  it("leaves STOPPED campaigns alone", () => {
    assert.equal(
      sendCanonDrift({ id: 1, status: "STOPPED", enable_ai_esp_matching: false, min_time_btwn_emails: 20 }),
      null,
    );
  });

  it("flags PAUSED, DRAFTED, COMPLETED and ACTIVE drift", () => {
    for (const status of ["PAUSED", "DRAFTED", "COMPLETED", "ACTIVE"]) {
      const d = sendCanonDrift({ id: 2, status, enable_ai_esp_matching: false, min_time_btwn_emails: 20 });
      assert.deepEqual(d && [d.espOff, d.gapOff], [true, true], status);
    }
  });

  it("clean campaign has no drift; string '10' counts as 10", () => {
    assert.equal(sendCanonDrift({ id: 3, status: "ACTIVE", enable_ai_esp_matching: true, min_time_btwn_emails: "10" }), null);
  });

  it("gapExempt only skips the gap, not ESP matching", () => {
    const d = sendCanonDrift({ id: 4, status: "ACTIVE", enable_ai_esp_matching: false, min_time_btwn_emails: 3 }, { gapExempt: true });
    assert.deepEqual(d && [d.espOff, d.gapOff], [true, false]);
  });

  it("schedule body echoes the current window and changes only the gap", () => {
    const body = sendCanonScheduleBody({ id: 5, scheduler_cron_value: cron, max_leads_per_day: 100 });
    assert.deepEqual(body, {
      timezone: "America/New_York",
      days_of_the_week: [1, 2, 3, 4],
      start_hour: "08:00",
      end_hour: "19:00",
      min_time_btw_emails: 10,
      max_new_leads_per_day: 100,
    });
    assert.equal(sendCanonScheduleBody({ id: 6, scheduler_cron_value: null }), null);
  });

  it("fix writes settings + schedule only, never a status field", async () => {
    const w = writer();
    const c: SendCanonCampaign = { id: 7, status: "PAUSED", enable_ai_esp_matching: false, min_time_btwn_emails: 20, scheduler_cron_value: cron, max_leads_per_day: 50 };
    const out = await convergeSendCanon(c, w, { dryRun: false });
    assert.deepEqual(out?.fixed, ["esp", "gap"]);
    assert.deepEqual(w.calls.map((x) => x[0]), ["settings", "schedule"]);
    assert.deepEqual(w.calls[0][2], { enable_ai_esp_matching: true });
    for (const [, , body] of w.calls) assert.equal("status" in body, false);
  });

  it("dry run flags without writing", async () => {
    const w = writer();
    const out = await convergeSendCanon({ id: 8, status: "ACTIVE", enable_ai_esp_matching: false, min_time_btwn_emails: 20, scheduler_cron_value: cron }, w, { dryRun: true });
    assert.equal(w.calls.length, 0);
    assert.deepEqual(out?.problems.map((p) => p.kind), ["esp_matching_off", "campaign_send_gap"]);
  });

  it("no schedule window: gap stays a finding, nothing guessed", async () => {
    const w = writer();
    const out = await convergeSendCanon({ id: 9, status: "DRAFTED", enable_ai_esp_matching: true, min_time_btwn_emails: 20 }, w, { dryRun: false });
    assert.equal(w.calls.length, 0);
    assert.match(out!.problems[0].detail, /no schedule window/);
  });

  it("does not touch STOPPED even when not a dry run", async () => {
    const w = writer();
    const out = await convergeSendCanon({ id: 10, status: "STOPPED", enable_ai_esp_matching: false, min_time_btwn_emails: 20, scheduler_cron_value: cron }, w, { dryRun: false });
    assert.equal(out, null);
    assert.equal(w.calls.length, 0);
  });
});
