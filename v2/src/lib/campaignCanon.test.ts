import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  espMatchingViolation,
  htmlBodyViolation,
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
        { espOff: true, gapOff: true },
      );
    }
    assert.equal(sendCanonLockDrift({ ...base, status: "PAUSED", enableAiEspMatching: true, minTimeBtwnEmails: 10 }), null);
  });
  it("schedule payload keeps the window and sets only the gap; no status", async () => {
    const { sendCanonLockSchedulePayload } = await import("./campaignCanon.js");
    const body = sendCanonLockSchedulePayload({
      ...base, status: "PAUSED", timezone: "America/Chicago", daysOfTheWeek: [1, 2, 3, 4, 5],
      startHour: "09:00", endHour: "17:00", maxLeadsPerDay: 100, minTimeBtwnEmails: 20,
    });
    assert.deepEqual(body, {
      timezone: "America/Chicago", days_of_the_week: [1, 2, 3, 4, 5], start_hour: "09:00",
      end_hour: "17:00", min_time_btw_emails: 10, max_new_leads_per_day: 100,
    });
    assert.equal("status" in (body ?? {}), false);
  });
});
