import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  campaignHasSendWindowRule,
  convergeSendCanon,
  isTestCampaign,
  sendCanonDrift,
  sendCanonScheduleBody,
  standingSendWindowBody,
  type SendCanonCampaign,
} from "./campaignSendCanon.js";

const cron = { tz: "America/New_York", days: [1, 2, 3, 4], startHour: "08:00", endHour: "19:00" };
const chicago = { tz: "America/Chicago", days: [1, 2, 3, 4], startHour: "09:00", endHour: "18:00" };

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
      const d = sendCanonDrift({
        id: 2,
        name: "Goliath Education",
        status,
        enable_ai_esp_matching: false,
        min_time_btwn_emails: 20,
        scheduler_cron_value: cron,
        max_leads_per_day: 10000,
      });
      assert.deepEqual(d && [d.espOff, d.gapOff], [true, true], status);
    }
  });

  it("clean campaign has no drift; string '10' counts as 10", () => {
    assert.equal(
      sendCanonDrift({
        id: 3,
        name: "Goliath Education",
        status: "ACTIVE",
        enable_ai_esp_matching: true,
        min_time_btwn_emails: "10",
        scheduler_cron_value: cron,
        max_leads_per_day: 10000,
      }),
      null,
    );
  });

  it("gapExempt only skips the gap, not ESP matching", () => {
    const d = sendCanonDrift(
      {
        id: 4,
        name: "Goliath Education",
        status: "ACTIVE",
        enable_ai_esp_matching: false,
        min_time_btwn_emails: 3,
        scheduler_cron_value: cron,
        max_leads_per_day: 10000,
      },
      { gapExempt: true },
    );
    assert.deepEqual(d && [d.espOff, d.gapOff, d.windowOff], [true, false, false]);
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
    const c: SendCanonCampaign = {
      id: 7,
      name: "Goliath Education",
      status: "PAUSED",
      enable_ai_esp_matching: false,
      min_time_btwn_emails: 20,
      scheduler_cron_value: cron,
      max_leads_per_day: 10000,
    };
    const out = await convergeSendCanon(c, w, { dryRun: false });
    assert.deepEqual(out?.fixed, ["esp", "gap"]);
    assert.deepEqual(w.calls.map((x) => x[0]), ["settings", "schedule"]);
    assert.deepEqual(w.calls[0][2], { enable_ai_esp_matching: true });
    for (const [, , body] of w.calls) assert.equal("status" in body, false);
  });

  it("dry run flags without writing", async () => {
    const w = writer();
    const out = await convergeSendCanon(
      {
        id: 8,
        name: "Goliath Education",
        status: "ACTIVE",
        enable_ai_esp_matching: false,
        min_time_btwn_emails: 20,
        scheduler_cron_value: cron,
        max_leads_per_day: 10000,
      },
      w,
      { dryRun: true },
    );
    assert.equal(w.calls.length, 0);
    assert.deepEqual(out?.problems.map((p) => p.kind), ["esp_matching_off", "campaign_send_gap"]);
  });

  it("does not touch STOPPED even when not a dry run", async () => {
    const w = writer();
    const out = await convergeSendCanon(
      {
        id: 10,
        status: "STOPPED",
        enable_ai_esp_matching: false,
        min_time_btwn_emails: 20,
        scheduler_cron_value: cron,
      },
      w,
      { dryRun: false },
    );
    assert.equal(out, null);
    assert.equal(w.calls.length, 0);
  });
});

describe("D306 send-window converge", () => {
  it("standing body is Mon–Thu 08:00–19:00 ET at 10000 leads and never has status", () => {
    const body = standingSendWindowBody();
    assert.deepEqual(body, {
      timezone: "America/New_York",
      days_of_the_week: [1, 2, 3, 4],
      start_hour: "08:00",
      end_hour: "19:00",
      min_time_btw_emails: 10,
      max_new_leads_per_day: 10000,
    });
    assert.equal("status" in body, false);
  });

  it("overwrites a custom Chicago / Friday window", async () => {
    const w = writer();
    const out = await convergeSendCanon(
      {
        id: 11,
        name: "SG Subs BizDev",
        status: "ACTIVE",
        enable_ai_esp_matching: true,
        min_time_btwn_emails: 10,
        scheduler_cron_value: chicago,
        max_leads_per_day: 10000,
      },
      w,
      { dryRun: false },
    );
    assert.deepEqual(out?.fixed, ["window"]);
    assert.equal(w.calls.length, 1);
    assert.equal(w.calls[0]![0], "schedule");
    assert.deepEqual(w.calls[0]![2], standingSendWindowBody());
    assert.equal("status" in w.calls[0]![2], false);
  });

  it("skips Gabe caller follow-ups, shells, test campaigns, and STOPPED", () => {
    assert.equal(
      campaignHasSendWindowRule({ id: 4085158, name: "Gabe Calls | SalesGlider", status: "ACTIVE" }),
      false,
    );
    assert.equal(
      campaignHasSendWindowRule({ id: 2, name: "Canary shell: #4 Live A", status: "ACTIVE" }),
      false,
    );
    assert.equal(
      campaignHasSendWindowRule({ id: 3, name: "Pod control shell", status: "ACTIVE" }),
      false,
    );
    assert.equal(
      campaignHasSendWindowRule({ id: 4, name: "DW Word Hunt Shell", status: "ACTIVE" }),
      false,
    );
    assert.equal(isTestCampaign({ name: "1-step test" }), true);
    assert.equal(
      campaignHasSendWindowRule({ id: 5, name: "1-step test", status: "ACTIVE" }),
      false,
    );
    assert.equal(
      campaignHasSendWindowRule({ id: 6, name: "Goliath Education", status: "STOPPED" }),
      false,
    );
    assert.equal(
      campaignHasSendWindowRule({ id: 7, name: "Goliath Education", status: "ACTIVE" }),
      true,
    );
  });

  it("does not write a schedule for Gabe even when the gap is 3", async () => {
    const w = writer();
    const out = await convergeSendCanon(
      {
        id: 4085158,
        name: "Gabe Calls | SalesGlider",
        status: "ACTIVE",
        enable_ai_esp_matching: true,
        min_time_btwn_emails: 3,
        scheduler_cron_value: {
          tz: "America/Chicago",
          days: [1, 2, 3, 4, 5],
          startHour: "07:00",
          endHour: "20:00",
        },
        max_leads_per_day: 10000,
      },
      w,
      { dryRun: false },
    );
    assert.equal(out, null);
    assert.equal(w.calls.length, 0);
  });

  it("shells and tests keep their window; only the 10m gap is written", async () => {
    const w = writer();
    const out = await convergeSendCanon(
      {
        id: 12,
        name: "Canary shell: #4 Live A",
        status: "ACTIVE",
        enable_ai_esp_matching: true,
        min_time_btwn_emails: 20,
        scheduler_cron_value: chicago,
        max_leads_per_day: 500,
      },
      w,
      { dryRun: false },
    );
    assert.deepEqual(out?.fixed, ["gap"]);
    assert.equal(w.calls.length, 1);
    assert.deepEqual(w.calls[0]![2], {
      timezone: "America/Chicago",
      days_of_the_week: [1, 2, 3, 4],
      start_hour: "09:00",
      end_hour: "18:00",
      min_time_btw_emails: 10,
      max_new_leads_per_day: 500,
    });
  });

  it("never calls a status writer", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("./campaignSendCanon.ts", import.meta.url), "utf8"),
    );
    assert.doesNotMatch(source, /updateCampaignStatus|\/status/);
  });
});
