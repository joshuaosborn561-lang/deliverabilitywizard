/**
 * D43 — 2 weeks on / 2 weeks off for *client* inboxes, split evenly
 * per client (A/B). The fortnight follows ISO weeks in America/New_York.
 *
 * Block 0 → A on, B off. Block 1 → reverse.
 *
 * D192 — the cut is ESP-balanced: ~50/50 within Outlook and within
 * Gmail (and a leftover "other" bucket). Alphabetical-only half
 * drifted live POD tags off the ESP 50/50 Josh locked.
 */

import { normalizeSenderEspFamily } from "./esp.js";

export type RestCohort = "A" | "B";
export type CohortEspKind = "outlook" | "gmail" | "other";

export interface ClientCohortInbox {
  email: string;
  /** Smartlead account.type (OUTLOOK / GMAIL / …). Omitted → other. */
  type?: string | null;
}

export function cohortEspKind(
  type: string | null | undefined,
): CohortEspKind {
  const family = normalizeSenderEspFamily(type);
  if (family === "microsoft") return "outlook";
  if (family === "google") return "gmail";
  return "other";
}

export function normalizeCohortInboxes(
  inboxes: Array<string | ClientCohortInbox>,
): Array<{ email: string; esp: CohortEspKind }> {
  const seen = new Set<string>();
  const out: Array<{ email: string; esp: CohortEspKind }> = [];
  for (const row of inboxes) {
    const email =
      typeof row === "string"
        ? row.trim().toLowerCase()
        : String(row.email ?? "")
            .trim()
            .toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push({
      email,
      esp: typeof row === "string" ? "other" : cohortEspKind(row.type),
    });
  }
  return out;
}

/**
 * Even A/B split of one client's inboxes. D192: split independently
 * inside Outlook and inside Gmail so each pod stays ~50/50 ESP.
 * Within an ESP, sort by email so the cut is stable. First half
 * (ceil) is A; the rest is B. Email-only callers (no type) land in
 * the "other" bucket and keep the old alphabetical half.
 */
export function assignClientCohorts(
  inboxes: Array<string | ClientCohortInbox>,
): Map<string, RestCohort> {
  const rows = normalizeCohortInboxes(inboxes);
  const byEsp = new Map<CohortEspKind, string[]>();
  for (const row of rows) {
    const list = byEsp.get(row.esp) ?? [];
    list.push(row.email);
    byEsp.set(row.esp, list);
  }
  const out = new Map<string, RestCohort>();
  for (const emails of byEsp.values()) {
    const sorted = [...emails].sort();
    const mid = Math.ceil(sorted.length / 2);
    sorted.forEach((email, index) => {
      out.set(email, index < mid ? "A" : "B");
    });
  }
  return out;
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

/** True when this cohort is sitting this fortnight. */
export function isOffWeek(
  cohort: RestCohort,
  now: Date = new Date(),
): boolean {
  const block = restFortnightBlock(now);
  return block === 0 ? cohort === "B" : cohort === "A";
}

export function onWeekCohort(now: Date = new Date()): RestCohort {
  return restFortnightBlock(now) === 0 ? "A" : "B";
}
