/**
 * D303 — every campaign sends Mon–Thu 8am–7pm America/New_York.
 * Smartlead days: 0 = Sunday … 6 = Saturday.
 */

export const CANON_SEND_TIMEZONE = "America/New_York";
export const CANON_SEND_DAYS = [1, 2, 3, 4] as const;
export const CANON_SEND_START = "08:00";
export const CANON_SEND_END = "19:00";

export interface CampaignSchedule {
  timezone?: string | null;
  days?: number[] | null;
  startHour?: string | null;
  endHour?: string | null;
  minTimeBtwEmails?: number | null;
  maxLeadsPerDay?: number | null;
}

function hhmm(value: string | null | undefined): string {
  const m = String(value ?? "").match(/^(\d{1,2}):(\d{2})/);
  return m ? `${m[1]!.padStart(2, "0")}:${m[2]}` : "";
}

/** Read Smartlead's campaign scheduler fields (shape varies by endpoint). */
export function readCampaignSchedule(raw: unknown): CampaignSchedule {
  const row = (raw ?? {}) as Record<string, unknown>;
  const cron = (row.scheduler_cron_value ?? {}) as Record<string, unknown>;
  const days = (cron.days ?? row.days_of_the_week) as unknown;
  const num = (v: unknown) => (typeof v === "number" ? v : Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : null);
  return {
    timezone: (cron.tz ?? row.timezone ?? null) as string | null,
    days: Array.isArray(days) ? days.map(Number).filter(Number.isFinite) : null,
    startHour: (cron.startHour ?? row.start_hour ?? null) as string | null,
    endHour: (cron.endHour ?? row.end_hour ?? null) as string | null,
    minTimeBtwEmails: num(row.min_time_btwn_emails ?? row.min_time_btw_emails),
    maxLeadsPerDay: num(row.max_leads_per_day ?? row.max_new_leads_per_day),
  };
}

export function scheduleOnCanon(s: CampaignSchedule): boolean {
  const days = [...(s.days ?? [])].sort((a, b) => a - b);
  return (
    s.timezone === CANON_SEND_TIMEZONE &&
    days.length === CANON_SEND_DAYS.length &&
    days.every((d, i) => d === CANON_SEND_DAYS[i]) &&
    hhmm(s.startHour) === CANON_SEND_START &&
    hhmm(s.endHour) === CANON_SEND_END
  );
}

/**
 * Body for POST /campaigns/{id}/schedule. Keeps the campaign's own send
 * gap and daily new-lead cap (D30 gap is never touched). Returns null when
 * those are unknown — never guess them.
 */
export function canonSchedulePayload(s: CampaignSchedule): Record<string, unknown> | null {
  if (typeof s.minTimeBtwEmails !== "number" || typeof s.maxLeadsPerDay !== "number") {
    return null;
  }
  return {
    timezone: CANON_SEND_TIMEZONE,
    days_of_the_week: [...CANON_SEND_DAYS],
    start_hour: CANON_SEND_START,
    end_hour: CANON_SEND_END,
    min_time_btw_emails: s.minTimeBtwEmails,
    max_new_leads_per_day: s.maxLeadsPerDay,
  };
}
