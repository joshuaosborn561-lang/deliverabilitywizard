/**
 * D41 — 2 weeks on / 2 weeks off for client inboxes.
 *
 * Cohort is a stable hash of the email (A or B). The fortnight block is
 * derived from the ISO week number in America/New_York so the cut flips
 * with the business calendar, not the UTC clock.
 *
 * Block 0 → A on, B off. Block 1 → reverse.
 */

export type RestCohort = "A" | "B";

/** djb2-style hash; stable across processes. */
export function hashEmail(email: string): number {
  const normalized = email.trim().toLowerCase();
  let hash = 5381;
  for (let i = 0; i < normalized.length; i += 1) {
    hash = ((hash << 5) + hash + normalized.charCodeAt(i)) >>> 0;
  }
  return hash;
}

export function restCohortOf(email: string): RestCohort {
  return hashEmail(email) % 2 === 0 ? "A" : "B";
}

export function nyYmd(now: Date = new Date()): {
  year: number;
  month: number;
  day: number;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const num = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? NaN);
  return { year: num("year"), month: num("month"), day: num("day") };
}

/**
 * ISO-8601 week number for the America/New_York calendar date.
 * Week 1 is the week with the year's first Thursday.
 */
export function isoWeekNumberNy(now: Date = new Date()): number {
  const { year, month, day } = nyYmd(now);
  const utc = new Date(Date.UTC(year, month - 1, day));
  const weekday = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  return Math.ceil(((utc.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

export function restFortnightBlock(now: Date = new Date()): 0 | 1 {
  return (Math.floor(isoWeekNumberNy(now) / 2) % 2) as 0 | 1;
}

/** True when this mailbox's cohort is the off-week this fortnight. */
export function isOffWeek(email: string, now: Date = new Date()): boolean {
  const cohort = restCohortOf(email);
  const block = restFortnightBlock(now);
  return block === 0 ? cohort === "B" : cohort === "A";
}

export function onWeekCohort(now: Date = new Date()): RestCohort {
  return restFortnightBlock(now) === 0 ? "A" : "B";
}
