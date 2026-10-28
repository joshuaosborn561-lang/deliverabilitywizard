import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  campaignHasSendGapRule,
  campaignHasSendWindowRule,
  espMatchingViolation,
  htmlBodyViolation,
  isBookingFollowUpCampaign,
  isCallsCampaign,
  looksLikeHtml,
  plainTextSettingsViolation,
  sendWindowViolation,
  standingSchedulePayload,
  trackingIsOff,
} from "./campaignCanon.js";
import type { SlimCampaign } from "../types.js";

function campaign(partial: Partial<SlimCampaign> = {}): SlimCampaign {
  return {
    id: 1,
    name: "Acme Outreach",
    status: "ACTIVE",
    clientId: 10,
    enableAiEspMatching: true,
    sendAsPlainText: true,
    trackSettings: ["DONT_TRACK_EMAIL_OPEN", "DONT_TRACK_LINK_CLICK"],
    timezone: "America/New_York",
    daysOfTheWeek: [1, 2, 3, 4],
    startHour: "08:00",
    endHour: "19:00",
    minTimeBtwnEmails: 10,
    ...partial,
  };
}

describe("D274 ESP matching", () => {
  it("flags enable_ai_esp_matching only when known off, not when unread", () => {
    assert.equal(espMatchingViolation(campaign()), null);
    assert.match(String(espMatchingViolation(campaign({ enableAiEspMatching: false }))), /esp_matching/i);
    assert.equal(espMatchingViolation(campaign({ enableAiEspMatching: undefined })), null);
    assert.equal(espMatchingViolation(campaign({ enableAiEspMatching: null })), null);
  });
});

describe("D275 plain text + tracking off", () => {
  it("accepts DONT_TRACK_* and GET aliases", () => {
    assert.equal(trackingIsOff(["DONT_EMAIL_OPEN", "DONT_LINK_CLICK"]), true);
    assert.equal(trackingIsOff(["DONT_TRACK_EMAIL_OPEN"]), false);
  });

  it("flags HTML bodies and tracking on; unread settings are not a miss", () => {
    assert.equal(looksLikeHtml("Hi {{first_name}}"), false);
    assert.equal(looksLikeHtml("<div>Hi</div>"), true);
    assert.ok(plainTextSettingsViolation(campaign({ sendAsPlainText: false })));
    assert.equal(plainTextSettingsViolation(campaign({ sendAsPlainText: undefined, trackSettings: undefined })), null);
    assert.ok(htmlBodyViolation([{ campaignId: 1, body: "<p>Hello</p>" }]));
  });
});

describe("D182 send window", () => {
  it("intends the standing Mon–Thu 08:00–19:00 ET window; missing fields are not a miss", () => {
    assert.equal(sendWindowViolation(campaign()), null);
    assert.ok(sendWindowViolation(campaign({ daysOfTheWeek: [1, 2, 3, 4, 5] })));
    assert.ok(sendWindowViolation(campaign({ timezone: "America/Chicago" })));
    assert.equal(
      sendWindowViolation(
        campaign({
          timezone: undefined,
          daysOfTheWeek: undefined,
          startHour: undefined,
          endHour: undefined,
        }),
      ),
      null,
    );
    assert.equal(
      sendWindowViolation(campaign({ id: 4085158, name: "Gabe Calls | SalesGlider" })),
      null,
    );
    assert.equal(
      sendWindowViolation(campaign({ id: 4236756, name: "Cayden Calls | SalesGlider" })),
      null,
    );
    assert.equal(
      sendWindowViolation(
        campaign({
          id: 20,
          name: "Booking Follow Up - SalesGlider",
          daysOfTheWeek: [1, 2, 3, 4, 5],
          maxLeadsPerDay: 100,
        }),
      ),
      null,
    );
    assert.ok(sendWindowViolation(campaign({ name: "SalesGlider Nurture", timezone: "America/Chicago" })));
    const payload = standingSchedulePayload();
    assert.deepEqual(payload.days_of_the_week, [1, 2, 3, 4]);
    assert.equal(payload.timezone, "America/New_York");
  });
});

describe("D304 LOCKED send canon (v2 mirror)", () => {
  const base = { id: 1, name: "x", clientId: 1 } as const;
  it("skips STOPPED; flags PAUSED / DRAFTED / COMPLETED", async () => {
    const { sendCanonLockDrift } = await import("./campaignCanon.js");
    assert.equal(sendCanonLockDrift({ ...base, status: "STOPPED", enableAiEspMatching: false, minTimeBtwnEmails: 20 }), null);
    for (const status of ["PAUSED", "DRAFTED", "COMPLETED", "ACTIVE"]) {
      assert.deepEqual(
        sendCanonLockDrift({ ...base, status, enableAiEspMatching: false, minTimeBtwnEmails: 20 }),
        { espOff: true, gapOff: true, windowOff: false },
      );
    }
    assert.equal(sendCanonLockDrift({ ...base, status: "PAUSED", enableAiEspMatching: true, minTimeBtwnEmails: 10 }), null);
  });
  it("D306: window-eligible payload overwrites a custom window; no status", async () => {
    const { sendCanonLockSchedulePayload, standingSchedulePayload } = await import("./campaignCanon.js");
    const body = sendCanonLockSchedulePayload({
      ...base, status: "PAUSED", timezone: "America/Chicago", daysOfTheWeek: [1, 2, 3, 4, 5],
      startHour: "09:00", endHour: "17:00", maxLeadsPerDay: 100, minTimeBtwnEmails: 20,
    });
    assert.deepEqual(body, standingSchedulePayload());
    assert.equal("status" in (body ?? {}), false);
  });

  it("D306: shells echo the window and only set the 10m gap", async () => {
    const { sendCanonLockSchedulePayload } = await import("./campaignCanon.js");
    const body = sendCanonLockSchedulePayload({
      id: 2,
      name: "Canary shell: #4 Live A",
      status: "ACTIVE",
      clientId: 1,
      timezone: "America/Chicago",
      daysOfTheWeek: [1, 2, 3, 4],
      startHour: "09:00",
      endHour: "18:00",
      maxLeadsPerDay: 500,
      minTimeBtwnEmails: 20,
    });
    assert.deepEqual(body, {
      timezone: "America/Chicago",
      days_of_the_week: [1, 2, 3, 4],
      start_hour: "09:00",
      end_hour: "18:00",
      min_time_btw_emails: 10,
      max_new_leads_per_day: 500,
    });
  });
});

describe("D306 send-window exemptions (Calls | + Booking Follow Up)", () => {
  it("skips every Calls | campaign and every Booking Follow Up; enforces the rest", () => {
    assert.equal(isCallsCampaign({ id: 4236756, name: "Cayden Calls | SalesGlider" }), true);
    assert.equal(isCallsCampaign({ id: 99, name: "Ada Calls | Acme" }), true);
    assert.equal(isCallsCampaign({ id: 4085158, name: "Gabe Lopez Follow-up" }), true);
    assert.equal(isBookingFollowUpCampaign({ name: "Booking Follow Up - SalesGlider" }), true);
    assert.equal(
      campaignHasSendWindowRule({ id: 4236756, name: "Cayden Calls | SalesGlider", status: "PAUSED" }),
      false,
    );
    assert.equal(
      campaignHasSendWindowRule({
        id: 20,
        name: "Booking Follow Up - SalesGlider",
        status: "COMPLETED",
      }),
      false,
    );
    assert.equal(
      campaignHasSendWindowRule({ id: 21, name: "SalesGlider Nurture", status: "ACTIVE" }),
      true,
    );
    assert.equal(
      campaignHasSendWindowRule({ id: 22, name: "SG Referral Hosts 1015 – PE", status: "ACTIVE" }),
      true,
    );
    assert.equal(
      campaignHasSendWindowRule({
        id: 23,
        name: "SG Subs BizDev AirPods/Tickets 1019",
        status: "ACTIVE",
      }),
      true,
    );
    assert.equal(
      campaignHasSendGapRule({ id: 4236756, name: "Cayden Calls | SalesGlider", status: "PAUSED" }),
      false,
    );
    assert.equal(
      campaignHasSendGapRule({
        id: 20,
        name: "Booking Follow Up - SalesGlider",
        status: "COMPLETED",
      }),
      true,
    );
  });

  it("Calls | payload is null; Booking Follow Up echoes the window", async () => {
    const { sendCanonLockSchedulePayload } = await import("./campaignCanon.js");
    assert.equal(
      sendCanonLockSchedulePayload({
        id: 4236756,
        name: "Cayden Calls | SalesGlider",
        status: "PAUSED",
        clientId: 1,
        timezone: "America/Chicago",
        daysOfTheWeek: [1, 2, 3, 4, 5],
        startHour: "07:00",
        endHour: "20:00",
        minTimeBtwnEmails: 3,
      }),
      null,
    );
    assert.deepEqual(
      sendCanonLockSchedulePayload({
        id: 20,
        name: "Booking Follow Up - SalesGlider",
        status: "COMPLETED",
        clientId: 1,
        timezone: "America/New_York",
        daysOfTheWeek: [1, 2, 3, 4, 5],
        startHour: "08:00",
        endHour: "19:00",
        maxLeadsPerDay: 100,
        minTimeBtwnEmails: 20,
      }),
      {
        timezone: "America/New_York",
        days_of_the_week: [1, 2, 3, 4, 5],
        start_hour: "08:00",
        end_hour: "19:00",
        min_time_btw_emails: 10,
        max_new_leads_per_day: 100,
      },
    );
  });
});

describe("D306 restores D242 caller follow-up 3m gap (v2)", () => {
  it("caller follow-up at 3m is not gap drift; constant is 3", async () => {
    const { sendCanonLockDrift } = await import("./campaignCanon.js");
    const { CALLER_FOLLOWUP_MIN_TIME_BTW_EMAILS } = await import("../canon/constants.js");
    assert.equal(CALLER_FOLLOWUP_MIN_TIME_BTW_EMAILS, 3);
    assert.equal(
      sendCanonLockDrift({
        id: 4085158,
        name: "Gabe Calls | SalesGlider",
        status: "ACTIVE",
        clientId: 1,
        enableAiEspMatching: true,
        minTimeBtwnEmails: 3,
        timezone: "America/Chicago",
        daysOfTheWeek: [1, 2, 3, 4, 5],
        startHour: "07:00",
        endHour: "20:00",
      }),
      null,
    );
  });

  it("never mentions a status writer", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("./campaignCanon.ts", import.meta.url), "utf8");
    assert.doesNotMatch(source, /updateCampaignStatus|\/status/);
  });
});
