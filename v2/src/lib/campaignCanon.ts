/**
 * D182 / D274 / D275 — campaign ESP matching, plain text + tracking off,
 * standing send window. Intended writes only in shadow.
 */

import {
  CALLER_FOLLOWUP_MIN_TIME_BTW_EMAILS,
  MIN_TIME_BTW_EMAILS,
} from "../canon/constants.js";
import { isCallerFollowUpCampaign } from "./poc.js";
import type { SequenceSample, SlimCampaign } from "../types.js";

export const STANDING_SEND_WINDOW = {
  timezone: "America/New_York",
  daysOfTheWeek: [1, 2, 3, 4] as const,
  startHour: "08:00",
  endHour: "19:00",
  minTimeBtwEmails: MIN_TIME_BTW_EMAILS,
  maxLeadsPerDay: 10000,
};

export const TRACK_OFF = ["DONT_TRACK_EMAIL_OPEN", "DONT_TRACK_LINK_CLICK"] as const;
export const TRACK_OFF_ALIASES = [
  "DONT_TRACK_EMAIL_OPEN",
  "DONT_TRACK_LINK_CLICK",
  "DONT_EMAIL_OPEN",
  "DONT_LINK_CLICK",
] as const;

const HTML_RE = /<\/?(?:html|body|div|span|p|br|table|tr|td|a|img|font|strong|em|b|i|u)\b/i;

export function looksLikeHtml(body: string | null | undefined): boolean {
  return HTML_RE.test(String(body ?? ""));
}

export function trackingIsOff(settings: readonly string[] | null | undefined): boolean {
  const set = new Set((settings ?? []).map((s) => s.toUpperCase()));
  const openOff = set.has("DONT_TRACK_EMAIL_OPEN") || set.has("DONT_EMAIL_OPEN");
  const linkOff = set.has("DONT_TRACK_LINK_CLICK") || set.has("DONT_LINK_CLICK");
  return openOff && linkOff;
}

export function espMatchingViolation(campaign: SlimCampaign): string | null {
  if (campaign.enableAiEspMatching !== false) return null;
  return "enable_ai_esp_matching is off (want Gmail→Gmail, Outlook→Outlook)";
}

export function plainTextSettingsViolation(campaign: SlimCampaign): string | null {
  const reasons: string[] = [];
  if (campaign.sendAsPlainText === false) {
    reasons.push("send_as_plain_text is off");
  }
  if (campaign.trackSettings != null && !trackingIsOff(campaign.trackSettings)) {
    reasons.push("open or link tracking is on");
  }
  return reasons.length ? reasons.join("; ") : null;
}

export function htmlBodyViolation(sequences: SequenceSample[]): string | null {
  const html = sequences.find((s) => looksLikeHtml(s.body));
  if (!html) return null;
  return "sequence body contains HTML (plain text only)";
}

function normHour(value: string | null | undefined): string {
  const raw = String(value ?? "").trim();
  const m = raw.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return raw;
  return `${m[1]!.padStart(2, "0")}:${m[2]}`;
}

function sameDays(have: readonly number[] | null | undefined, want: readonly number[]): boolean {
  if (!have || have.length !== want.length) return false;
  const a = [...have].sort((x, y) => x - y).join(",");
  const b = [...want].sort((x, y) => x - y).join(",");
  return a === b;
}

export function sendWindowViolation(campaign: SlimCampaign): string | null {
  if (isCallerFollowUpCampaign(campaign)) return null;
  const want = STANDING_SEND_WINDOW;
  const reasons: string[] = [];
  if (campaign.timezone != null && campaign.timezone !== "" && campaign.timezone !== want.timezone) {
    reasons.push(`timezone ${campaign.timezone} want ${want.timezone}`);
  }
  if (
    campaign.daysOfTheWeek != null &&
    campaign.daysOfTheWeek.length > 0 &&
    !sameDays(campaign.daysOfTheWeek, want.daysOfTheWeek)
  ) {
    reasons.push(
      `days ${JSON.stringify(campaign.daysOfTheWeek)} want Mon–Thu`,
    );
  }
  if (campaign.startHour != null && campaign.startHour !== "" && normHour(campaign.startHour) !== want.startHour) {
    reasons.push(`start ${campaign.startHour} want ${want.startHour}`);
  }
  if (campaign.endHour != null && campaign.endHour !== "" && normHour(campaign.endHour) !== want.endHour) {
    reasons.push(`end ${campaign.endHour} want ${want.endHour}`);
  }
  if (
    campaign.minTimeBtwnEmails != null &&
    campaign.minTimeBtwnEmails !== want.minTimeBtwEmails &&
    campaign.minTimeBtwnEmails !== CALLER_FOLLOWUP_MIN_TIME_BTW_EMAILS
  ) {
    reasons.push(`gap ${campaign.minTimeBtwnEmails} want ${want.minTimeBtwEmails}`);
  }
  return reasons.length ? reasons.join("; ") : null;
}

export function standingSchedulePayload(): Record<string, unknown> {
  return {
    timezone: STANDING_SEND_WINDOW.timezone,
    days_of_the_week: [...STANDING_SEND_WINDOW.daysOfTheWeek],
    start_hour: STANDING_SEND_WINDOW.startHour,
    end_hour: STANDING_SEND_WINDOW.endHour,
    min_time_btw_emails: STANDING_SEND_WINDOW.minTimeBtwEmails,
    max_leads_per_day: STANDING_SEND_WINDOW.maxLeadsPerDay,
  };
}

export function plainTextSettingsPayload(): Record<string, unknown> {
  return {
    send_as_plain_text: true,
    track_settings: [...TRACK_OFF],
    enable_ai_esp_matching: true,
  };
}

/**
 * D304 — LOCKED: every non-STOPPED campaign has ESP matching ON and a
 * 10-minute gap. Caller follow-ups keep their D242 3m gap pending Josh.
 * Settings / schedule intents only; never status.
 */
export interface SendCanonLockDrift {
  espOff: boolean;
  gapOff: boolean;
}

export function sendCanonLockDrift(campaign: SlimCampaign): SendCanonLockDrift | null {
  if (String(campaign.status ?? "").trim().toUpperCase() === "STOPPED") return null;
  const espOff = campaign.enableAiEspMatching != null && campaign.enableAiEspMatching !== true;
  const gapOff =
    campaign.minTimeBtwnEmails != null &&
    campaign.minTimeBtwnEmails !== MIN_TIME_BTW_EMAILS &&
    !isCallerFollowUpCampaign(campaign);
  if (!espOff && !gapOff) return null;
  return { espOff, gapOff };
}

/** Schedule body that keeps the campaign's own window and only sets the gap. */
export function sendCanonLockSchedulePayload(campaign: SlimCampaign): Record<string, unknown> | null {
  if (!campaign.timezone || !campaign.daysOfTheWeek?.length || !campaign.startHour || !campaign.endHour) {
    return null;
  }
  const body: Record<string, unknown> = {
    timezone: campaign.timezone,
    days_of_the_week: [...campaign.daysOfTheWeek],
    start_hour: campaign.startHour,
    end_hour: campaign.endHour,
    min_time_btw_emails: MIN_TIME_BTW_EMAILS,
  };
  if (campaign.maxLeadsPerDay != null && campaign.maxLeadsPerDay > 0) {
    body.max_new_leads_per_day = campaign.maxLeadsPerDay;
  }
  return body;
}
