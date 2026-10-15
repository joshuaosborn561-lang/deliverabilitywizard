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
  it("flags enable_ai_esp_matching off or missing", () => {
    assert.equal(espMatchingViolation(campaign()), null);
    assert.match(String(espMatchingViolation(campaign({ enableAiEspMatching: false }))), /esp_matching/i);
    assert.ok(espMatchingViolation(campaign({ enableAiEspMatching: undefined })));
  });
});

describe("D275 plain text + tracking off", () => {
  it("accepts DONT_TRACK_* and GET aliases", () => {
    assert.equal(trackingIsOff(["DONT_EMAIL_OPEN", "DONT_LINK_CLICK"]), true);
    assert.equal(trackingIsOff(["DONT_TRACK_EMAIL_OPEN"]), false);
  });

  it("flags HTML bodies and tracking on", () => {
    assert.equal(looksLikeHtml("Hi {{first_name}}"), false);
    assert.equal(looksLikeHtml("<div>Hi</div>"), true);
    assert.ok(plainTextSettingsViolation(campaign({ sendAsPlainText: false })));
    assert.ok(htmlBodyViolation([{ campaignId: 1, body: "<p>Hello</p>" }]));
  });
});

describe("D182 send window", () => {
  it("intends the standing Mon–Thu 08:00–19:00 ET window", () => {
    assert.equal(sendWindowViolation(campaign()), null);
    assert.ok(sendWindowViolation(campaign({ daysOfTheWeek: [1, 2, 3, 4, 5] })));
    assert.ok(sendWindowViolation(campaign({ timezone: "America/Chicago" })));
    assert.equal(
      sendWindowViolation(campaign({ id: 4085158, name: "Gabe Calls | SalesGlider" })),
      null,
    );
    const payload = standingSchedulePayload();
    assert.deepEqual(payload.days_of_the_week, [1, 2, 3, 4]);
    assert.equal(payload.timezone, "America/New_York");
  });
});
