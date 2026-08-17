/**
 * D39 — Client-inbox rest cohorts (A/B/C).
 *
 * Stable hash → equal thirds. One cohort rests each ISO week (~33%); the
 * other two stay live (~66%). Rest is send-cap zero, not campaign removal —
 * membership stays so SmartDelivery keep testing them.
 */

export type RestCohort = "A" | "B" | "C";

const COHORTS: RestCohort[] = ["A", "B", "C"];

/** Stable A/B/C from email (lowercase). */
export function cohortForEmail(email: string): RestCohort {
  const key = email.trim().toLowerCase();
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return COHORTS[hash % 3]!;
}

/**
 * Which cohort rests this week (America/New_York calendar week).
 * Week 0 → A, 1 → B, 2 → C, then rotate.
 */
export function restingCohortForDate(now: Date = new Date()): RestCohort {
  const week = isoWeekNumberNy(now);
  return COHORTS[week % 3]!;
}

/** ISO week number in America/New_York (Mon-based, ISO-8601-ish). */
export function isoWeekNumberNy(now: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const y = Number(parts.find((p) => p.type === "year")?.value);
  const m = Number(parts.find((p) => p.type === "month")?.value);
  const d = Number(parts.find((p) => p.type === "day")?.value);
  const utc = new Date(Date.UTC(y, m - 1, d));
  // Thursday in current week decides the year (ISO).
  const dayNum = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  return Math.ceil(((utc.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

export function isCohortRestingThisWeek(
  cohort: RestCohort,
  now: Date = new Date(),
): boolean {
  return cohort === restingCohortForDate(now);
}
