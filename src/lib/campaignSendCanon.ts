/**
 * D304 — LOCKED: every Smartlead campaign has AI ESP matching ON
 * (`enable_ai_esp_matching: true`) and a 10-minute campaign gap
 * (`min_time_btw_emails: 10`). STOPPED campaigns are left alone.
 *
 * Settings only, never status:
 * - ESP matching is written with POST /campaigns/{id}/settings
 *   (`enable_ai_esp_matching` is in that endpoint's schema).
 * - The gap is written with POST /campaigns/{id}/schedule
 *   (`min_time_btw_emails` is in that endpoint's schema; it is not a
 *   documented /settings body field). The schedule body echoes the
 *   campaign's current window (timezone, days, hours, daily cap) so only
 *   the gap changes. With no window to echo, nothing is written and the
 *   drift stays a finding.
 * Neither endpoint accepts a status field. Status has its own endpoint,
 * which this module never calls.
 *
 * Caller follow-ups keep their own D242 gap (3 minutes) until Josh says
 * otherwise; ESP matching still applies to them.
 */

export const SEND_CANON_GAP_MINS = 10;

export interface SendCanonCampaign {
  id: number;
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
  gapBefore: number | string | null;
}

export function sendCanonSkipsStatus(status: unknown): boolean {
  return String(status ?? "").trim().toUpperCase() === "STOPPED";
}

function gapValue(raw: number | string | null | undefined): number {
  if (raw == null || raw === "") return Number.NaN;
  return typeof raw === "string" ? Number(raw) : raw;
}

export function sendCanonDrift(
  campaign: SendCanonCampaign,
  opts: { gapExempt?: boolean; espExempt?: boolean } = {},
): SendCanonDrift | null {
  if (sendCanonSkipsStatus(campaign.status)) return null;
  const espOff = !opts.espExempt && campaign.enable_ai_esp_matching !== true;
  const gapOff =
    !opts.gapExempt && gapValue(campaign.min_time_btwn_emails) !== SEND_CANON_GAP_MINS;
  if (!espOff && !gapOff) return null;
  return {
    campaignId: campaign.id,
    espOff,
    gapOff,
    gapBefore: campaign.min_time_btwn_emails ?? null,
  };
}

/** Body for POST /campaigns/{id}/settings. ESP matching only. */
export function sendCanonSettingsBody(): { enable_ai_esp_matching: true } {
  return { enable_ai_esp_matching: true };
}

/**
 * Body for POST /campaigns/{id}/schedule that keeps the current window and
 * sets only the gap. Returns null when there is no window to echo.
 */
export function sendCanonScheduleBody(
  campaign: SendCanonCampaign,
): Record<string, unknown> | null {
  const raw = campaign.scheduler_cron_value;
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
  const body: Record<string, unknown> = {
    timezone: tz,
    days_of_the_week: days,
    start_hour: start,
    end_hour: end,
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
  fixed: Array<"esp" | "gap">;
  problems: Array<{ kind: "esp_matching_off" | "campaign_send_gap"; detail: string }>;
}

/** Flag, and unless dryRun, fix one campaign. Never touches status. */
export async function convergeSendCanon(
  campaign: SendCanonCampaign,
  writer: SendCanonWriter,
  opts: { dryRun: boolean; gapExempt?: boolean; espExempt?: boolean },
): Promise<SendCanonOutcome | null> {
  const drift = sendCanonDrift(campaign, {
    gapExempt: opts.gapExempt,
    espExempt: opts.espExempt,
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
  if (drift.gapOff) {
    const detail = `${String(drift.gapBefore ?? "unset")} → ${SEND_CANON_GAP_MINS}m (D304)`;
    const body = sendCanonScheduleBody(campaign);
    if (opts.dryRun) out.problems.push({ kind: "campaign_send_gap", detail });
    else if (!body) {
      out.problems.push({ kind: "campaign_send_gap", detail: `${detail} not written: no schedule window to keep` });
    } else {
      try {
        await writer.updateCampaignSchedule(campaign.id, body);
        out.fixed.push("gap");
      } catch (e) {
        out.problems.push({ kind: "campaign_send_gap", detail: `${detail} failed: ${message(e)}` });
      }
    }
  }
  return out;
}
