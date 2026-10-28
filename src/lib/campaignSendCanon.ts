/**
 * D304 / D306 — send canon.
 *
 * D304 LOCKED: every Smartlead campaign has AI ESP matching ON
 * (`enable_ai_esp_matching: true`) and a 10-minute campaign gap
 * (`min_time_btw_emails: 10`). STOPPED campaigns are left alone.
 *
 * D306: live campaigns also converge the send window to Monday–Thursday
 * 08:00–19:00 America/New_York with `max_leads_per_day` 10000. Custom
 * windows are overwritten. Skips CALLER FOLLOW-UP (they keep Mon–Fri
 * 07:00–20:00 Chicago with a 3-minute gap), shells / canaries
 * (`isAnyShellCampaign`), word-hunt, test campaigns, and STOPPED.
 *
 * Settings / schedule only, never status:
 * - ESP matching is written with POST /campaigns/{id}/settings.
 * - Window + gap are written with POST /campaigns/{id}/schedule.
 * Neither endpoint accepts a status field. Status has its own endpoint,
 * which this module never calls.
 */

import { isAnyShellCampaign } from "./canaryShell.js";
import { isCallerFollowUpCampaign } from "./callerFollowUp.js";
import { isWordHuntShellCampaign } from "./wordHuntShell.js";

export const SEND_CANON_GAP_MINS = 10;
export const SEND_WINDOW_TIMEZONE = "America/New_York";
export const SEND_WINDOW_DAYS = [1, 2, 3, 4] as const;
export const SEND_WINDOW_START_HOUR = "08:00";
export const SEND_WINDOW_END_HOUR = "19:00";
export const SEND_WINDOW_MAX_LEADS = 10000;

export interface SendCanonCampaign {
  id: number;
  name?: string | null;
  status?: string | null;
  enable_ai_esp_matching?: boolean | null;
  min_time_btwn_emails?: number | string | null;
  max_leads_per_day?: number | string | null;
  scheduler_cron_value?: unknown;
}

export interface SendCanonDrift {
  campaignId: number;
  espOff: boolean;
  gapOff: boolean;
  windowOff: boolean;
  gapBefore: number | string | null;
}

export function sendCanonSkipsStatus(status: unknown): boolean {
  return String(status ?? "").trim().toUpperCase() === "STOPPED";
}

function gapValue(raw: number | string | null | undefined): number {
  if (raw == null || raw === "") return Number.NaN;
  return typeof raw === "string" ? Number(raw) : raw;
}

export function isTestCampaign(campaign: {
  name?: string | null;
}): boolean {
  const name = String(campaign.name ?? "").trim();
  if (!name) return false;
  return /(?:^|[\s|:/_-])test(?:[\s|:/_-]|$)/i.test(name);
}

/** D304 gap applies everywhere except STOPPED and CALLER FOLLOW-UP. */
export function campaignHasSendGapRule(campaign: {
  id?: number | null;
  name?: string | null;
  status?: string | null;
}): boolean {
  if (sendCanonSkipsStatus(campaign.status)) return false;
  if (isCallerFollowUpCampaign(campaign)) return false;
  return true;
}

export function campaignHasSendWindowRule(campaign: {
  id?: number | null;
  name?: string | null;
  status?: string | null;
}): boolean {
  if (sendCanonSkipsStatus(campaign.status)) return false;
  if (isCallerFollowUpCampaign(campaign)) return false;
  if (isAnyShellCampaign(campaign)) return false;
  if (
    isWordHuntShellCampaign({
      id: campaign.id ?? undefined,
      name: campaign.name,
    })
  ) {
    return false;
  }
  if (isTestCampaign(campaign)) return false;
  return true;
}

export function sendCanonDrift(
  campaign: SendCanonCampaign,
  opts: { gapExempt?: boolean; espExempt?: boolean; windowExempt?: boolean } = {},
): SendCanonDrift | null {
  if (sendCanonSkipsStatus(campaign.status)) return null;
  const windowRule = campaignHasSendWindowRule(campaign);
  const espOff = !opts.espExempt && campaign.enable_ai_esp_matching !== true;
  const gapOff =
    !opts.gapExempt &&
    campaignHasSendGapRule(campaign) &&
    gapValue(campaign.min_time_btwn_emails) !== SEND_CANON_GAP_MINS;
  const windowOff = !opts.windowExempt && windowRule && sendWindowIsOff(campaign);
  if (!espOff && !gapOff && !windowOff) return null;
  return {
    campaignId: campaign.id,
    espOff,
    gapOff,
    windowOff,
    gapBefore: campaign.min_time_btwn_emails ?? null,
  };
}

/** Body for POST /campaigns/{id}/settings. ESP matching only. */
export function sendCanonSettingsBody(): { enable_ai_esp_matching: true } {
  return { enable_ai_esp_matching: true };
}

function parseSchedulerCron(
  raw: unknown,
): {
  tz: string;
  days: number[];
  startHour: string;
  endHour: string;
} | null {
  let cron: Record<string, unknown> | null = null;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    cron = raw as Record<string, unknown>;
  } else if (typeof raw === "string" && raw.trim().startsWith("{")) {
    try {
      cron = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      cron = null;
    }
  }
  if (!cron) return null;
  const tz = typeof cron.tz === "string" ? cron.tz : null;
  const days = Array.isArray(cron.days)
    ? cron.days.map((d) => Number(d)).filter((d) => Number.isInteger(d))
    : [];
  const start = typeof cron.startHour === "string" ? cron.startHour : null;
  const end = typeof cron.endHour === "string" ? cron.endHour : null;
  if (!tz || !days.length || !start || !end) return null;
  return { tz, days, startHour: start, endHour: end };
}

export function sendWindowIsOff(campaign: SendCanonCampaign): boolean {
  const cron = parseSchedulerCron(campaign.scheduler_cron_value);
  if (!cron) return true;
  if (cron.tz !== SEND_WINDOW_TIMEZONE) return true;
  if (cron.startHour !== SEND_WINDOW_START_HOUR) return true;
  if (cron.endHour !== SEND_WINDOW_END_HOUR) return true;
  if (cron.days.length !== SEND_WINDOW_DAYS.length) return true;
  if (SEND_WINDOW_DAYS.some((d, i) => cron.days[i] !== d)) return true;
  const cap = Number(campaign.max_leads_per_day);
  if (!Number.isFinite(cap) || cap !== SEND_WINDOW_MAX_LEADS) return true;
  return false;
}

/** D306 standing window. Always 10000 new leads / day. */
export function standingSendWindowBody(): Record<string, unknown> {
  return {
    timezone: SEND_WINDOW_TIMEZONE,
    days_of_the_week: [...SEND_WINDOW_DAYS],
    start_hour: SEND_WINDOW_START_HOUR,
    end_hour: SEND_WINDOW_END_HOUR,
    min_time_btw_emails: SEND_CANON_GAP_MINS,
    max_new_leads_per_day: SEND_WINDOW_MAX_LEADS,
  };
}

/**
 * Body for POST /campaigns/{id}/schedule that keeps the current window and
 * sets only the gap. Returns null when there is no window to echo.
 * D306 eligible campaigns use standingSendWindowBody instead.
 */
export function sendCanonScheduleBody(
  campaign: SendCanonCampaign,
): Record<string, unknown> | null {
  const cron = parseSchedulerCron(campaign.scheduler_cron_value);
  if (!cron) return null;
  const body: Record<string, unknown> = {
    timezone: cron.tz,
    days_of_the_week: cron.days,
    start_hour: cron.startHour,
    end_hour: cron.endHour,
    min_time_btw_emails: SEND_CANON_GAP_MINS,
  };
  const cap = Number(campaign.max_leads_per_day);
  if (Number.isFinite(cap) && cap > 0) body.max_new_leads_per_day = cap;
  return body;
}

export interface SendCanonWriter {
  updateCampaignSettings(id: number, body: Record<string, unknown>): Promise<unknown>;
  updateCampaignSchedule(id: number, body: Record<string, unknown>): Promise<unknown>;
}

export interface SendCanonOutcome {
  campaignId: number;
  fixed: Array<"esp" | "gap" | "window">;
  problems: Array<{
    kind: "esp_matching_off" | "campaign_send_gap" | "send_window";
    detail: string;
  }>;
}

/** Flag, and unless dryRun, fix one campaign. Never touches status. */
export async function convergeSendCanon(
  campaign: SendCanonCampaign,
  writer: SendCanonWriter,
  opts: { dryRun: boolean; gapExempt?: boolean; espExempt?: boolean; windowExempt?: boolean },
): Promise<SendCanonOutcome | null> {
  const drift = sendCanonDrift(campaign, {
    gapExempt: opts.gapExempt,
    espExempt: opts.espExempt,
    windowExempt: opts.windowExempt,
  });
  if (!drift) return null;
  const out: SendCanonOutcome = { campaignId: campaign.id, fixed: [], problems: [] };
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
  if (drift.espOff) {
    const detail = `${String(campaign.enable_ai_esp_matching ?? "unset")} → true (D304)`;
    if (opts.dryRun) out.problems.push({ kind: "esp_matching_off", detail });
    else {
      try {
        await writer.updateCampaignSettings(campaign.id, sendCanonSettingsBody());
        out.fixed.push("esp");
      } catch (e) {
        out.problems.push({ kind: "esp_matching_off", detail: `${detail} failed: ${message(e)}` });
      }
    }
  }
  if (drift.windowOff || drift.gapOff) {
    const windowDetail = drift.windowOff
      ? "custom window → Mon–Thu 08:00–19:00 America/New_York (D306)"
      : null;
    const gapDetail = drift.gapOff
      ? `${String(drift.gapBefore ?? "unset")} → ${SEND_CANON_GAP_MINS}m`
      : null;
    const detail = [windowDetail, gapDetail].filter(Boolean).join("; ");
    const kind = drift.windowOff ? "send_window" : "campaign_send_gap";
    const body = drift.windowOff
      ? standingSendWindowBody()
      : sendCanonScheduleBody(campaign);
    if (!body) {
      if (drift.gapOff) {
        out.problems.push({
          kind: "campaign_send_gap",
          detail: `${detail || `${String(drift.gapBefore ?? "unset")} → ${SEND_CANON_GAP_MINS}m`} (no schedule window to echo)`,
        });
      }
    } else if (opts.dryRun) {
      out.problems.push({ kind, detail });
    } else {
      try {
        await writer.updateCampaignSchedule(campaign.id, body);
        if (drift.windowOff) out.fixed.push("window");
        if (drift.gapOff) out.fixed.push("gap");
      } catch (e) {
        out.problems.push({ kind, detail: `${detail} failed: ${message(e)}` });
      }
    }
  }
  return out;
}
