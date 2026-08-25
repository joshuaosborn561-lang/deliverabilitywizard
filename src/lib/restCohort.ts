/**
 * D43 — 2 weeks on / 2 weeks off for *client* inboxes, split evenly
 * per client (A/B). The fortnight follows ISO weeks in America/New_York.
 *
 * Block 0 → A on, B off. Block 1 → reverse.
 */

export type RestCohort = "A" | "B";

/**
 * Even A/B split of one client's inboxes. Sorted by email so the cut is
 * stable across runs. First half (ceil) is A; the rest is B.
 */
export function assignClientCohorts(emails: string[]): Map<string, RestCohort> {
  const sorted = [
    ...new Set(
      emails.map((email) => email.trim().toLowerCase()).filter(Boolean),
    ),
  ].sort();
  const mid = Math.ceil(sorted.length / 2);
  const out = new Map<string, RestCohort>();
  sorted.forEach((email, index) => {
    out.set(email, index < mid ? "A" : "B");
  });
  return out;
}

/**
 * D68 — prefer a mailbox's existing POD-A / POD-B tag so the pool does
 * not flip when a new inbox lands. Untagged boxes fill toward an even
 * split (same ceil-to-A cut as assignClientCohorts). No tags ⇒ identical
 * to assignClientCohorts.
 */
export function resolveClientCohorts(
  rows: Array<{ email: string; tagged?: RestCohort | null }>,
): Map<string, RestCohort> {
  const unique = new Map<string, RestCohort | null>();
  for (const row of rows) {
    const email = row.email.trim().toLowerCase();
    if (!email) continue;
    if (!unique.has(email)) {
      unique.set(email, row.tagged === "A" || row.tagged === "B" ? row.tagged : null);
    }
  }
  const tagged = [...unique.entries()].filter(
    (entry): entry is [string, RestCohort] => entry[1] === "A" || entry[1] === "B",
  );
  if (!tagged.length) return assignClientCohorts([...unique.keys()]);

  const out = new Map<string, RestCohort>(tagged);
  const untagged = [...unique.keys()].filter((email) => !out.has(email)).sort();
  const targetA = Math.ceil(unique.size / 2);
  let aCount = [...out.values()].filter((cohort) => cohort === "A").length;
  for (const email of untagged) {
    if (aCount < targetA) {
      out.set(email, "A");
      aCount += 1;
    } else {
      out.set(email, "B");
    }
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
