/**
 * Same send and lead reading as campaign-watchdog.
 * Sends are today's dated analytics-by-date `sent_count`.
 * A lifetime `sent_count` is not today's sends when a dated row exists.
 * Leads left are notStarted + inProgress. Mailbox `daily_sent_count`
 * and the lead-runout snapshot are not this reading.
 *
 * Pace is campaign-watchdog's volume target (40 senders × ~30), not a
 * canon rule and not the sum of mailbox caps.
 */

export const WATCHDOG_DAILY_TARGET = 1200;
/**
 * The day "sends today" is counted in. Every live campaign's
 * `scheduler_cron_value.tz` is America/New_York and the standing send
 * window is 07:00–19:00 ET (D327), so the send day is the Eastern day.
 * Between 23:00 and 24:00 Central the Chicago date is still yesterday
 * while the send day has already rolled over.
 */
export const WATCHDOG_TIMEZONE = "America/New_York";

export function ymdInZone(date: Date, timeZone = WATCHDOG_TIMEZONE): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function unwrap(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  for (const key of ["data", "result", "analytics"]) {
    const inner = record[key];
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      return inner as Record<string, unknown>;
    }
  }
  return record;
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function pick(row: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = num(row[key]);
    if (value != null) return value;
  }
  return null;
}

function rowDate(row: Record<string, unknown>): string | undefined {
  for (const key of ["date", "day", "start_date", "stats_date", "sent_date"]) {
    const value = row[key];
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  }
  return undefined;
}

function volumeFromRow(row: Record<string, unknown>): { sent: number; bounced: number } {
  return {
    sent: pick(row, ["sent_count", "sent", "emails_sent", "total_sent"]) ?? 0,
    bounced: pick(row, ["bounce_count", "bounces", "total_bounced", "bounced"]) ?? 0,
  };
}

/**
 * Day sent/bounce for one campaign. Never treat lifetime `sent_count` as
 * today when a dated row (or an empty day array) is present.
 */
export function parseTodayVolume(
  raw: unknown,
  day?: string,
): { sent: number; bounced: number } {
  const root = unwrap(raw);
  if (!root) return { sent: 0, bounced: 0 };
  for (const key of ["data", "result", "analytics", "days", "stats"]) {
    const value = root[key];
    if (!Array.isArray(value)) continue;
    const rows = value.filter(
      (row): row is Record<string, unknown> => !!row && typeof row === "object",
    );
    const dated = rows.map((row) => ({ date: rowDate(row), ...volumeFromRow(row) }));
    if (day && dated.some((row) => row.date) && !dated.some((row) => row.date === day)) {
      return { sent: 0, bounced: 0 };
    }
    const matched = day ? dated.filter((row) => !row.date || row.date === day) : dated;
    return matched.reduce(
      (sum, row) => ({
        sent: sum.sent + Math.max(0, row.sent),
        bounced: sum.bounced + Math.max(0, row.bounced),
      }),
      { sent: 0, bounced: 0 },
    );
  }
  return volumeFromRow(root);
}

/**
 * Remaining leads that can still send: not started plus in progress, from
 * `campaign_lead_stats` on `campaigns/{id}/analytics`. A campaign whose
 * stats say 0 total leads has 0 left (an ACTIVE campaign that ran dry is
 * the top-up case) — null only when the response carries no lead stats.
 */
export function parseWatchdogLeadsLeft(raw: unknown): number | null {
  const root = unwrap(raw);
  if (!root) return null;
  const leadStats = unwrap(
    root.campaign_lead_stats ?? root.campaignLeadStats ?? root.lead_stats,
  );
  const total =
    (leadStats ? pick(leadStats, ["total", "total_leads"]) : null) ??
    pick(root, ["total_leads", "totalLeads"]);
  const notStarted =
    (leadStats ? pick(leadStats, ["notStarted", "not_started"]) : null) ??
    pick(root, ["not_started", "leads_not_started"]);
  const inProgress = leadStats
    ? pick(leadStats, ["inprogress", "in_progress", "inProgress"])
    : null;
  if (notStarted != null || inProgress != null) {
    return Math.max(0, (notStarted ?? 0) + (inProgress ?? 0));
  }
  if (total === 0) return 0;
  return null;
}
