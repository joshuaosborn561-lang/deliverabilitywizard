/**
 * D335 — weekly mailbox health report (Josh, 2026-11-11: "turn off all
 * deliverability testing" spec, item 5). Built only from the D334 daily
 * snapshots already on disk: no Smartlead read, no placement test, no
 * action. Per inbox and per domain: reply rate, bounce rate, warmup score,
 * week-over-week trend and flags, grouped by sg-owner and POD.
 *
 * Pure: config, week math, aggregation and Slack text. The service
 * (`services/mailboxHealthWeekly.ts`) does the I/O.
 */
import { chicagoWallClock } from "./canonOpsHours.js";
import {
  addDays,
  isYmd,
  MAILBOX_HEALTH_TIMEZONE,
  ratePct,
  type MailboxHealthFlag,
  type MailboxHealthRow,
  type MailboxHealthTrend,
} from "./mailboxHealthDaily.js";

/** Monday 8:30am America/Chicago. The hour must stay 06–19 CT. */
export const WEEKLY_HEALTH_DEFAULT_CRON = "30 8 * * 1";
export const WEEKLY_HEALTH_ALERT_PREFIX = "weekly_health_report";
export const WEEKLY_HEALTH_TOP_INBOXES = 10;
export const WEEKLY_HEALTH_TOP_DOMAINS = 5;
export const WEEKLY_HEALTH_TOP_GROUPS = 8;

export interface WeeklyHealthConfig {
  enabled: boolean;
  cron: string;
}

export function loadWeeklyHealthConfig(env: NodeJS.ProcessEnv = process.env): WeeklyHealthConfig {
  const raw = env.WEEKLY_HEALTH_REPORT_ENABLED?.trim().toLowerCase();
  return {
    enabled: raw === undefined || raw === "" ? true : ["1", "true", "yes", "on"].includes(raw),
    cron: env.CRON_WEEKLY_HEALTH_REPORT?.trim() || WEEKLY_HEALTH_DEFAULT_CRON,
  };
}

// ---------------------------------------------------------------- weeks

/** Monday (YYYY-MM-DD) of the Mon–Sun week containing `ymd`. */
export function weekStartOf(ymd: string): string {
  const dow = new Date(`${ymd}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(ymd, -((dow + 6) % 7));
}

/** The last fully finished Mon–Sun week as of `now` (America/Chicago). */
export function lastCompletedWeek(now: Date): string {
  const today = chicagoWallClock(now, MAILBOX_HEALTH_TIMEZONE).ymd;
  return addDays(weekStartOf(today), -7);
}

/** `?week=` → Monday of that week; null when not a YYYY-MM-DD date. */
export function parseWeekParam(raw: unknown): string | null {
  return isYmd(raw) ? weekStartOf(raw) : null;
}

export function weekDates(weekStart: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

/** Stored day as the report needs it (subset of `MailboxHealthDay`). */
export interface WeeklyInputDay {
  date: string;
  rows: Record<string, MailboxHealthRow>;
  trends: MailboxHealthTrend[];
}

// ---------------------------------------------------------------- aggregation

export interface WeeklyMetrics {
  sent: number;
  replies: number;
  bounces: number;
  /** Percent 0–100, null when nothing was sent. */
  replyRate: number | null;
  bounceRate: number | null;
  /** Newest non-null warmup score in the week (per domain: mean of its inboxes). */
  warmupScore: number | null;
  /** Days with a snapshot row in the week. */
  days: number;
}

export interface WeeklyTrend {
  /** Percentage points vs the prior week; null when either side is null. */
  replyRatePts: number | null;
  bounceRatePts: number | null;
  warmupPts: number | null;
}

export interface WeeklyInbox {
  email: string;
  domain: string;
  esp: MailboxHealthRow["esp"];
  owner: string | null;
  pod: "A" | "B" | null;
  week: WeeklyMetrics;
  prior: WeeklyMetrics | null;
  trend: WeeklyTrend;
  /** Distinct D334 trend flags raised on any day of the week. */
  flags: MailboxHealthFlag[];
}

export interface WeeklyDomain {
  domain: string;
  /** Most common owner / POD among its inboxes; pod null when mixed. */
  owner: string | null;
  pod: "A" | "B" | null;
  inboxes: number;
  flaggedInboxes: number;
  week: WeeklyMetrics;
  prior: WeeklyMetrics | null;
  trend: WeeklyTrend;
  flags: MailboxHealthFlag[];
}

export interface WeeklyGroup {
  owner: string | null;
  pod: "A" | "B" | null;
  inboxes: number;
  domains: number;
  flaggedInboxes: number;
  week: WeeklyMetrics;
  prior: WeeklyMetrics | null;
  trend: WeeklyTrend;
}

export interface WeeklyHealthReport {
  week: string;
  weekEnd: string;
  priorWeek: string;
  /** Snapshot dates found in the week / prior week. */
  snapshotDates: string[];
  priorSnapshotDates: string[];
  totals: {
    inboxes: number;
    domains: number;
    flaggedInboxes: number;
    flaggedDomains: number;
    week: WeeklyMetrics;
    prior: WeeklyMetrics | null;
    trend: WeeklyTrend;
  };
  /** Sorted by owner, POD, then sent (desc). */
  groups: WeeklyGroup[];
  /** Flagged first (most flags), then by email. */
  inboxes: WeeklyInbox[];
  /** Flagged first (most flagged inboxes), then by domain. */
  domains: WeeklyDomain[];
}

interface Acc {
  sent: number;
  replies: number;
  bounces: number;
  days: number;
  /** [date, score] newest wins. */
  warmup: [string, number] | null;
}

const emptyAcc = (): Acc => ({ sent: 0, replies: 0, bounces: 0, days: 0, warmup: null });

function addRow(acc: Acc, row: MailboxHealthRow): void {
  acc.days += 1;
  if (row.sent !== null) {
    acc.sent += row.sent;
    acc.replies += row.replies ?? 0;
    acc.bounces += row.bounces ?? 0;
  }
  if (row.warmupScore !== null && (!acc.warmup || row.date >= acc.warmup[0])) {
    acc.warmup = [row.date, row.warmupScore];
  }
}

function metricsOf(acc: Acc, warmupOverride?: number | null): WeeklyMetrics {
  return {
    sent: acc.sent,
    replies: acc.replies,
    bounces: acc.bounces,
    replyRate: ratePct(acc.replies, acc.sent),
    bounceRate: ratePct(acc.bounces, acc.sent),
    warmupScore: warmupOverride !== undefined ? warmupOverride : acc.warmup?.[1] ?? null,
    days: acc.days,
  };
}

function sumMetrics(list: WeeklyMetrics[]): WeeklyMetrics | null {
  if (!list.length) return null;
  const acc = emptyAcc();
  const warm: number[] = [];
  for (const m of list) {
    acc.sent += m.sent;
    acc.replies += m.replies;
    acc.bounces += m.bounces;
    acc.days = Math.max(acc.days, m.days);
    if (m.warmupScore !== null) warm.push(m.warmupScore);
  }
  const mean = warm.length
    ? Number((warm.reduce((a, b) => a + b, 0) / warm.length).toFixed(1))
    : null;
  return metricsOf(acc, mean);
}

const delta = (a: number | null | undefined, b: number | null | undefined): number | null =>
  a === null || a === undefined || b === null || b === undefined ? null : Number((a - b).toFixed(2));

function trendOf(week: WeeklyMetrics, prior: WeeklyMetrics | null): WeeklyTrend {
  return {
    replyRatePts: delta(week.replyRate, prior?.replyRate),
    bounceRatePts: delta(week.bounceRate, prior?.bounceRate),
    warmupPts: delta(week.warmupScore, prior?.warmupScore),
  };
}

function mode<T>(values: T[]): T | null {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: T | null = null;
  let bestN = 0;
  for (const [v, n] of counts) {
    if (n > bestN) {
      best = v;
      bestN = n;
    }
  }
  return best;
}

function accumulate(days: WeeklyInputDay[]): {
  acc: Map<string, Acc>;
  latest: Map<string, MailboxHealthRow>;
} {
  const acc = new Map<string, Acc>();
  const latest = new Map<string, MailboxHealthRow>();
  for (const day of [...days].sort((a, b) => a.date.localeCompare(b.date))) {
    for (const row of Object.values(day.rows)) {
      const a = acc.get(row.email) ?? emptyAcc();
      addRow(a, row);
      acc.set(row.email, a);
      latest.set(row.email, row);
    }
  }
  return { acc, latest };
}

/**
 * Build the report for the Mon–Sun week starting `week` from that week's
 * snapshots and the prior week's (for the week-over-week trend). Days
 * outside each week are ignored, so callers may pass extra.
 */
export function buildWeeklyHealthReport(input: {
  week: string;
  days: WeeklyInputDay[];
  priorDays: WeeklyInputDay[];
}): WeeklyHealthReport {
  const week = weekStartOf(input.week);
  const weekEnd = addDays(week, 6);
  const priorWeek = addDays(week, -7);
  const inWeek = (d: WeeklyInputDay, start: string) => d.date >= start && d.date <= addDays(start, 6);
  const cur = input.days.filter((d) => inWeek(d, week));
  const prev = input.priorDays.filter((d) => inWeek(d, priorWeek));

  const now = accumulate(cur);
  const before = accumulate(prev);
  const flags = new Map<string, Set<MailboxHealthFlag>>();
  for (const day of cur) {
    for (const t of day.trends ?? []) {
      const set = flags.get(t.email) ?? new Set<MailboxHealthFlag>();
      set.add(t.flag);
      flags.set(t.email, set);
    }
  }

  const inboxes: WeeklyInbox[] = [];
  for (const [email, acc] of now.acc) {
    const row = now.latest.get(email)!;
    const priorAcc = before.acc.get(email);
    const weekM = metricsOf(acc);
    const priorM = priorAcc ? metricsOf(priorAcc) : null;
    inboxes.push({
      email,
      domain: row.domain,
      esp: row.esp,
      owner: row.owner,
      pod: row.pod,
      week: weekM,
      prior: priorM,
      trend: trendOf(weekM, priorM),
      flags: [...(flags.get(email) ?? [])].sort(),
    });
  }
  inboxes.sort((a, b) => b.flags.length - a.flags.length || a.email.localeCompare(b.email));

  const byDomain = new Map<string, WeeklyInbox[]>();
  for (const i of inboxes) byDomain.set(i.domain, [...(byDomain.get(i.domain) ?? []), i]);
  const domains: WeeklyDomain[] = [];
  for (const [domain, list] of byDomain) {
    const weekM = sumMetrics(list.map((i) => i.week))!;
    const priorM = sumMetrics(list.flatMap((i) => (i.prior ? [i.prior] : [])));
    const pods = new Set(list.map((i) => i.pod));
    domains.push({
      domain,
      owner: mode(list.map((i) => i.owner)),
      pod: pods.size === 1 ? list[0]!.pod : null,
      inboxes: list.length,
      flaggedInboxes: list.filter((i) => i.flags.length).length,
      week: weekM,
      prior: priorM,
      trend: trendOf(weekM, priorM),
      flags: [...new Set(list.flatMap((i) => i.flags))].sort(),
    });
  }
  domains.sort(
    (a, b) => b.flaggedInboxes - a.flaggedInboxes || a.domain.localeCompare(b.domain),
  );

  const byGroup = new Map<string, WeeklyInbox[]>();
  for (const i of inboxes) {
    const key = `${i.owner ?? ""}\u0000${i.pod ?? ""}`;
    byGroup.set(key, [...(byGroup.get(key) ?? []), i]);
  }
  const groups: WeeklyGroup[] = [];
  for (const list of byGroup.values()) {
    const weekM = sumMetrics(list.map((i) => i.week))!;
    const priorM = sumMetrics(list.flatMap((i) => (i.prior ? [i.prior] : [])));
    groups.push({
      owner: list[0]!.owner,
      pod: list[0]!.pod,
      inboxes: list.length,
      domains: new Set(list.map((i) => i.domain)).size,
      flaggedInboxes: list.filter((i) => i.flags.length).length,
      week: weekM,
      prior: priorM,
      trend: trendOf(weekM, priorM),
    });
  }
  groups.sort(
    (a, b) =>
      (a.owner ?? "￿").localeCompare(b.owner ?? "￿") ||
      (a.pod ?? "Z").localeCompare(b.pod ?? "Z") ||
      b.week.sent - a.week.sent,
  );

  const totalWeek =
    sumMetrics(inboxes.map((i) => i.week)) ?? metricsOf(emptyAcc());
  const totalPrior = sumMetrics(inboxes.flatMap((i) => (i.prior ? [i.prior] : [])));
  return {
    week,
    weekEnd,
    priorWeek,
    snapshotDates: cur.map((d) => d.date).sort(),
    priorSnapshotDates: prev.map((d) => d.date).sort(),
    totals: {
      inboxes: inboxes.length,
      domains: domains.length,
      flaggedInboxes: inboxes.filter((i) => i.flags.length).length,
      flaggedDomains: domains.filter((d) => d.flaggedInboxes > 0).length,
      week: totalWeek,
      prior: totalPrior,
      trend: trendOf(totalWeek, totalPrior),
    },
    groups,
    inboxes,
    domains,
  };
}

// ---------------------------------------------------------------- Slack

const pct = (v: number | null): string => (v === null ? "—" : `${v.toFixed(2)}%`);

function arrow(v: number | null, unit = "pt"): string {
  if (v === null) return "";
  if (v === 0) return " (=)";
  return ` (${v > 0 ? "▲" : "▼"}${Math.abs(v).toFixed(v % 1 === 0 ? 0 : 2)}${unit})`;
}

const who = (owner: string | null, pod: "A" | "B" | null): string =>
  `${owner ?? "pool"}${pod ? ` · POD-${pod}` : ""}`;

/** Concise Slack post: totals, owner/POD groups, top flagged inboxes and domains. */
export function weeklyHealthSlackText(r: WeeklyHealthReport): string {
  const t = r.totals;
  const lines = [
    `*Weekly mailbox health — ${r.week} to ${r.weekEnd}* (alert only: nothing was paused or changed)`,
    `${t.inboxes} inboxes · ${t.domains} domains · ${t.week.sent} sent · reply ${pct(t.week.replyRate)}${arrow(t.trend.replyRatePts)} · bounce ${pct(t.week.bounceRate)}${arrow(t.trend.bounceRatePts)} · warmup ${t.week.warmupScore ?? "—"}${arrow(t.trend.warmupPts)} · flagged ${t.flaggedInboxes} inboxes / ${t.flaggedDomains} domains`,
  ];
  if (r.snapshotDates.length < 7) {
    lines.push(`_${r.snapshotDates.length}/7 daily snapshots this week; WoW vs ${r.priorSnapshotDates.length}/7._`);
  }
  if (r.groups.length) {
    lines.push("*By owner / POD*");
    const shown = [...r.groups]
      .sort((a, b) => b.flaggedInboxes - a.flaggedInboxes || b.week.sent - a.week.sent)
      .slice(0, WEEKLY_HEALTH_TOP_GROUPS);
    for (const g of shown) {
      lines.push(
        `• ${who(g.owner, g.pod)} — ${g.inboxes} inboxes, reply ${pct(g.week.replyRate)}${arrow(g.trend.replyRatePts)}, bounce ${pct(g.week.bounceRate)}${arrow(g.trend.bounceRatePts)}, ${g.flaggedInboxes} flagged`,
      );
    }
    if (r.groups.length > shown.length) lines.push(`…and ${r.groups.length - shown.length} more groups`);
  }
  const flaggedInboxes = r.inboxes.filter((i) => i.flags.length);
  if (flaggedInboxes.length) {
    lines.push(`*Top flagged inboxes* (${flaggedInboxes.length})`);
    for (const i of flaggedInboxes.slice(0, WEEKLY_HEALTH_TOP_INBOXES)) {
      lines.push(
        `• ${i.email} (${who(i.owner, i.pod)}) ${i.flags.join(", ")} — reply ${pct(i.week.replyRate)}, bounce ${pct(i.week.bounceRate)}, warmup ${i.week.warmupScore ?? "—"}${arrow(i.trend.warmupPts)}`,
      );
    }
  }
  const flaggedDomains = r.domains.filter((d) => d.flaggedInboxes > 0);
  if (flaggedDomains.length) {
    lines.push(`*Top flagged domains* (${flaggedDomains.length})`);
    for (const d of flaggedDomains.slice(0, WEEKLY_HEALTH_TOP_DOMAINS)) {
      lines.push(
        `• ${d.domain} (${who(d.owner, d.pod)}) ${d.flaggedInboxes}/${d.inboxes} inboxes flagged — reply ${pct(d.week.replyRate)}${arrow(d.trend.replyRatePts)}, bounce ${pct(d.week.bounceRate)}${arrow(d.trend.bounceRatePts)}`,
      );
    }
  }
  lines.push(`Full report: GET /mailbox-health/weekly?week=${r.week}`);
  return lines.join("\n");
}

/** One post per reported week. */
export function weeklyHealthAlertKey(week: string): string {
  return `${WEEKLY_HEALTH_ALERT_PREFIX}:${week}`;
}
