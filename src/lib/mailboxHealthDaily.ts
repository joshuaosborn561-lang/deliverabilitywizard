/**
 * D334 — daily per-mailbox health snapshot and trend flags (Josh,
 * 2026-11-11: replaces deliverability testing with daily metrics).
 *
 * Pure: config, snapshot math, trend evaluation, the cron-hour guard and
 * Slack text. The service (`services/mailboxHealthDaily.ts`) does the I/O.
 *
 * ALERT ONLY. A `mailbox_health_trend` finding never pauses, stops,
 * unpauses, rests, burns or swaps anything; those stay Deliverability /
 * Campaign Watchdog judgment calls.
 */
import {
  accountEmail,
  campaignIdsOf,
  type SmartleadAccountWithCampaigns,
} from "../clients/smartlead.js";
import type { SmartleadCampaign } from "../types/index.js";
import { extractRows } from "./bounceRate.js";
import { chicagoWallClock } from "./canonOpsHours.js";
import { mailboxPodTag } from "./canonStaffable.js";
import { normalizeSenderEspFamily } from "./esp.js";
import { slugForLegacyClientId } from "./ownership.js";

export const MAILBOX_HEALTH_TREND_KIND = "mailbox_health_trend";
export const MAILBOX_HEALTH_TIMEZONE = "America/Chicago";
/** No timer may fire 20:00–05:59 America/Chicago. */
export const MAILBOX_HEALTH_QUIET_START_HOUR = 20;
export const MAILBOX_HEALTH_QUIET_END_HOUR = 6;
export const MAILBOX_HEALTH_DEFAULT_CRON = "15 7 * * *";

export type MailboxHealthFlag =
  | "bounce_rate_high"
  | "bounce_rate_rising"
  | "reply_rate_drop"
  | "warmup_low"
  | "warmup_drop";

export interface MailboxHealthConfig {
  enabled: boolean;
  alertsEnabled: boolean;
  cron: string;
  retentionDays: number;
  /** Flag when 7-day rolling bounce rate (percent) is above this. */
  bounceRateMaxPct: number;
  bounceRollingDays: number;
  /** Min sends across the rolling window before the bounce-rate flag can fire. */
  bounceMinSent: number;
  /** Flag when the daily bounce rate rose on this many sending days in a row. */
  bounceRisingDays: number;
  /** Min sends on each of those days. */
  bounceRisingMinDailySent: number;
  /** Flag when recent reply rate is this percent or more below baseline. */
  replyDropPct: number;
  replyRecentDays: number;
  replyBaselineDays: number;
  /** Min sends in EACH window (recent and baseline). */
  replyMinSent: number;
  warmupMinScore: number;
  /** Flag when warmup score fell by at least this many points week over week. */
  warmupDropPoints: number;
}

const num = (raw: string | undefined, fallback: number, min = 0): number => {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? n : fallback;
};

const bool = (raw: string | undefined, fallback: boolean): boolean => {
  if (raw === undefined || raw.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
};

/** Env-overridable thresholds. Defaults are proposals for Josh / Deliverability to tune. */
export function loadMailboxHealthConfig(
  env: NodeJS.ProcessEnv = process.env,
): MailboxHealthConfig {
  return {
    enabled: bool(env.MAILBOX_HEALTH_DAILY_ENABLED, true),
    alertsEnabled: bool(env.MAILBOX_HEALTH_ALERTS_ENABLED, true),
    cron: env.CRON_MAILBOX_HEALTH_DAILY?.trim() || MAILBOX_HEALTH_DEFAULT_CRON,
    retentionDays: num(env.MAILBOX_HEALTH_RETENTION_DAYS, 120, 30),
    bounceRateMaxPct: num(env.MAILBOX_HEALTH_BOUNCE_RATE_MAX_PCT, 3),
    bounceRollingDays: num(env.MAILBOX_HEALTH_BOUNCE_ROLLING_DAYS, 7, 1),
    bounceMinSent: num(env.MAILBOX_HEALTH_BOUNCE_MIN_SENT, 50),
    bounceRisingDays: num(env.MAILBOX_HEALTH_BOUNCE_RISING_DAYS, 3, 2),
    bounceRisingMinDailySent: num(env.MAILBOX_HEALTH_BOUNCE_RISING_MIN_DAILY_SENT, 20),
    replyDropPct: num(env.MAILBOX_HEALTH_REPLY_DROP_PCT, 50),
    replyRecentDays: num(env.MAILBOX_HEALTH_REPLY_RECENT_DAYS, 7, 1),
    replyBaselineDays: num(env.MAILBOX_HEALTH_REPLY_BASELINE_DAYS, 14, 1),
    replyMinSent: num(env.MAILBOX_HEALTH_REPLY_MIN_SENT, 100),
    warmupMinScore: num(env.MAILBOX_HEALTH_WARMUP_MIN_SCORE, 90),
    warmupDropPoints: num(env.MAILBOX_HEALTH_WARMUP_DROP_POINTS, 5),
  };
}

// ---------------------------------------------------------------- cron guard

function expandField(field: string, min: number, max: number): number[] | null {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const [range, stepRaw] = part.split("/");
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1 || range === undefined) return null;
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = min;
      hi = max;
    } else if (/^\d+-\d+$/.test(range)) {
      [lo, hi] = range.split("-").map(Number) as [number, number];
    } else if (/^\d+$/.test(range)) {
      lo = Number(range);
      hi = stepRaw === undefined ? lo : max;
    } else {
      return null;
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Null when the cron expression only fires 06:00–19:59 America/Chicago,
 * else the reason. The job is always scheduled in America/Chicago, so
 * the hour field is a CT hour. Anything unparseable is rejected.
 */
export function mailboxHealthCronError(
  expression: string,
  envName = "CRON_MAILBOX_HEALTH_DAILY",
): string | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6) {
    return `${envName} "${expression}" must have 5 or 6 fields`;
  }
  const hourField = fields[fields.length - 4]!;
  const hours = expandField(hourField, 0, 23);
  if (!hours || !hours.length) {
    return `${envName} hour field "${hourField}" must be explicit hours (e.g. 7 or 7,13)`;
  }
  const bad = hours.filter(
    (h) => h >= MAILBOX_HEALTH_QUIET_START_HOUR || h < MAILBOX_HEALTH_QUIET_END_HOUR,
  );
  if (bad.length) {
    return `${envName} fires at ${bad.join(",")}h America/Chicago — no timer may run 20:00–05:59 CT`;
  }
  return null;
}

/** CT hours the cron fires at (empty when unparseable). */
export function mailboxHealthCronHours(expression: string): number[] {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6) return [];
  return expandField(fields[fields.length - 4]!, 0, 23) ?? [];
}

/** Runtime belt-and-braces: true when `now` is 06:00–19:59 America/Chicago. */
export function inMailboxHealthHours(now: Date = new Date()): boolean {
  const { hour } = chicagoWallClock(now, MAILBOX_HEALTH_TIMEZONE);
  return hour >= MAILBOX_HEALTH_QUIET_END_HOUR && hour < MAILBOX_HEALTH_QUIET_START_HOUR;
}

// ---------------------------------------------------------------- dates

export function isYmd(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

export function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The snapshot covers the previous America/Chicago calendar day (a whole sending day). */
export function snapshotDateFor(now: Date): string {
  return addDays(chicagoWallClock(now, MAILBOX_HEALTH_TIMEZONE).ymd, -1);
}

// ---------------------------------------------------------------- snapshot

export interface MailboxHealthRow {
  date: string;
  email: string;
  domain: string;
  emailAccountId: number;
  esp: "GOOGLE" | "MICROSOFT" | "OTHER";
  /** "A" / "B" from the POD-A / POD-B tag; null when untagged or dual. */
  pod: "A" | "B" | null;
  /** sg-owner slug from the D331 ownership resolution (read-only). */
  owner: string | null;
  ownerClientId: number | null;
  /** Null when Smartlead's name-wise health metrics had no row for the mailbox. */
  sent: number | null;
  replies: number | null;
  bounces: number | null;
  /** Percent 0–100, null when sent is 0 or unknown. */
  replyRate: number | null;
  bounceRate: number | null;
  /** warmup_details.warmup_reputation as a number 0–100. */
  warmupScore: number | null;
}

export interface SenderDayStats {
  email: string;
  sent: number;
  replies: number;
  bounces: number;
}

const EMAIL_KEYS = ["email", "from_email", "email_account", "account_email"];
const SENT_KEYS = ["sent_count", "sent", "total_sent", "emails_sent", "total_count"];
const REPLY_KEYS = ["reply_count", "replied_count", "replied", "total_replied", "total_replies"];
const BOUNCE_KEYS = ["bounce_count", "bounced_count", "bounced", "total_bounced"];

function pickNum(row: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const v = row[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

function pickStr(row: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const v = row[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/** Per-mailbox sent / replies / bounces from a name-wise health-metrics payload (rows summed per email). */
export function parseSenderDayStats(payload: unknown): Map<string, SenderDayStats> {
  const out = new Map<string, SenderDayStats>();
  for (const row of extractRows(payload)) {
    const email = pickStr(row, EMAIL_KEYS)?.toLowerCase();
    if (!email || !email.includes("@")) continue;
    const sent = pickNum(row, SENT_KEYS);
    if (sent === null || sent < 0) continue;
    const replies = Math.max(0, pickNum(row, REPLY_KEYS) ?? 0);
    const bounces = Math.max(0, pickNum(row, BOUNCE_KEYS) ?? 0);
    const prev = out.get(email);
    out.set(email, {
      email,
      sent: (prev?.sent ?? 0) + sent,
      replies: (prev?.replies ?? 0) + replies,
      bounces: (prev?.bounces ?? 0) + bounces,
    });
  }
  return out;
}

/** "100%", "97.5", 92 → number; anything else → null. */
export function parseWarmupScore(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const cleaned = raw.trim().replace(/%$/, "").trim();
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function ratePct(part: number, whole: number): number | null {
  if (!(whole > 0)) return null;
  return Number(((part / whole) * 100).toFixed(2));
}

function espLabel(account: SmartleadAccountWithCampaigns): MailboxHealthRow["esp"] {
  const fam = normalizeSenderEspFamily(account);
  return fam === "google" ? "GOOGLE" : fam === "microsoft" ? "MICROSOFT" : "OTHER";
}

/**
 * Mailboxes attached to at least one ACTIVE campaign, one row each.
 * Owner comes from what `SmartleadClient` already resolved (D331); this
 * never writes or re-resolves ownership.
 */
export function buildMailboxHealthRows(input: {
  date: string;
  campaigns: SmartleadCampaign[];
  accounts: SmartleadAccountWithCampaigns[];
  stats: Map<string, SenderDayStats>;
}): MailboxHealthRow[] {
  const active = new Set(
    input.campaigns
      .filter((c) => String(c.status ?? "").toUpperCase() === "ACTIVE")
      .map((c) => c.id),
  );
  const rows = new Map<string, MailboxHealthRow>();
  for (const account of input.accounts) {
    const email = accountEmail(account)?.toLowerCase();
    if (!email || rows.has(email)) continue;
    if (!campaignIdsOf(account).some((id) => active.has(id))) continue;
    const stat = input.stats.get(email);
    const clientId =
      typeof account.client_id === "number" && account.client_id > 0 ? account.client_id : null;
    rows.set(email, {
      date: input.date,
      email,
      domain: email.split("@")[1] ?? "",
      emailAccountId: account.id,
      esp: espLabel(account),
      pod: mailboxPodTag(account),
      owner: account.owner_slug ?? slugForLegacyClientId(clientId),
      ownerClientId: clientId,
      sent: stat ? stat.sent : null,
      replies: stat ? stat.replies : null,
      bounces: stat ? stat.bounces : null,
      replyRate: stat ? ratePct(stat.replies, stat.sent) : null,
      bounceRate: stat ? ratePct(stat.bounces, stat.sent) : null,
      warmupScore: parseWarmupScore(account.warmup_details?.warmup_reputation),
    });
  }
  return [...rows.values()].sort((a, b) => a.email.localeCompare(b.email));
}

// ---------------------------------------------------------------- trends

export interface MailboxHealthTrend {
  date: string;
  email: string;
  domain: string;
  owner: string | null;
  pod: "A" | "B" | null;
  flag: MailboxHealthFlag;
  detail: string;
}

/** history: date → (email → row). Must include `date` itself. */
export type MailboxHealthHistory = Map<string, Map<string, MailboxHealthRow>>;

function windowSums(
  history: MailboxHealthHistory,
  email: string,
  endDate: string,
  days: number,
): { sent: number; replies: number; bounces: number } {
  let sent = 0;
  let replies = 0;
  let bounces = 0;
  for (let i = 0; i < days; i += 1) {
    const row = history.get(addDays(endDate, -i))?.get(email);
    if (!row || row.sent === null) continue;
    sent += row.sent;
    replies += row.replies ?? 0;
    bounces += row.bounces ?? 0;
  }
  return { sent, replies, bounces };
}

/** Evaluate every trend flag for every mailbox in the `date` snapshot. */
export function evaluateMailboxHealthTrends(
  date: string,
  history: MailboxHealthHistory,
  cfg: MailboxHealthConfig,
): MailboxHealthTrend[] {
  const today = history.get(date);
  if (!today) return [];
  const out: MailboxHealthTrend[] = [];
  for (const row of today.values()) {
    const push = (flag: MailboxHealthFlag, detail: string) =>
      out.push({ date, email: row.email, domain: row.domain, owner: row.owner, pod: row.pod, flag, detail });

    // 1) bounce rate over the rolling window.
    const roll = windowSums(history, row.email, date, cfg.bounceRollingDays);
    if (roll.sent >= cfg.bounceMinSent) {
      const rate = (roll.bounces / roll.sent) * 100;
      if (rate > cfg.bounceRateMaxPct) {
        push(
          "bounce_rate_high",
          `${rate.toFixed(1)}% bounce over ${cfg.bounceRollingDays}d (${roll.bounces}/${roll.sent}) > ${cfg.bounceRateMaxPct}%`,
        );
      }
    }

    // 2) daily bounce rate rising N sending days in a row (inside the rolling window).
    const sendingDays: number[] = [];
    for (let i = cfg.bounceRollingDays - 1; i >= 0; i -= 1) {
      const r = history.get(addDays(date, -i))?.get(row.email);
      if (r && r.sent !== null && r.sent >= cfg.bounceRisingMinDailySent) {
        sendingDays.push(((r.bounces ?? 0) / r.sent) * 100);
      }
    }
    const lastN = sendingDays.slice(-cfg.bounceRisingDays);
    if (
      lastN.length === cfg.bounceRisingDays &&
      lastN.every((v, i) => i === 0 || v > lastN[i - 1]!)
    ) {
      push(
        "bounce_rate_rising",
        `bounce rate rose ${cfg.bounceRisingDays} sending days in a row: ${lastN.map((v) => `${v.toFixed(1)}%`).join(" → ")}`,
      );
    }

    // 3) reply-rate drop vs the baseline window immediately before the recent one.
    const recent = windowSums(history, row.email, date, cfg.replyRecentDays);
    const base = windowSums(history, row.email, addDays(date, -cfg.replyRecentDays), cfg.replyBaselineDays);
    if (recent.sent >= cfg.replyMinSent && base.sent >= cfg.replyMinSent && base.replies > 0) {
      const recentRate = (recent.replies / recent.sent) * 100;
      const baseRate = (base.replies / base.sent) * 100;
      const dropPct = ((baseRate - recentRate) / baseRate) * 100;
      if (dropPct > cfg.replyDropPct) {
        push(
          "reply_rate_drop",
          `reply rate ${recentRate.toFixed(2)}% (${cfg.replyRecentDays}d, ${recent.sent} sent) is ${dropPct.toFixed(0)}% below ${baseRate.toFixed(2)}% (${cfg.replyBaselineDays}d baseline, ${base.sent} sent)`,
        );
      }
    }

    // 4) warmup score low, or 5) down week over week.
    if (row.warmupScore !== null) {
      if (row.warmupScore < cfg.warmupMinScore) {
        push("warmup_low", `warmup score ${row.warmupScore} < ${cfg.warmupMinScore}`);
      }
      const prior = history.get(addDays(date, -7))?.get(row.email)?.warmupScore ?? null;
      if (prior !== null && prior - row.warmupScore >= cfg.warmupDropPoints) {
        push("warmup_drop", `warmup score ${prior} → ${row.warmupScore} week over week (−${(prior - row.warmupScore).toFixed(1)})`);
      }
    }
  }
  return out;
}

/** Canon finding string: `mailbox_health_trend: <email> <flag> — <detail>`. */
export function trendFinding(t: MailboxHealthTrend): string {
  return `${MAILBOX_HEALTH_TREND_KIND}: ${t.email} ${t.flag} — ${t.detail}`;
}

/** One alert per mailbox per flag per snapshot day. */
export function trendAlertKey(t: Pick<MailboxHealthTrend, "date" | "email" | "flag">): string {
  return `${MAILBOX_HEALTH_TREND_KIND}:${t.date}:${t.email}:${t.flag}`;
}

export const MAILBOX_HEALTH_SLACK_MAX_LINES = 40;

export function mailboxHealthAlertText(date: string, trends: MailboxHealthTrend[]): string {
  const lines = trends
    .slice(0, MAILBOX_HEALTH_SLACK_MAX_LINES)
    .map(
      (t) =>
        `• ${t.email} (${t.owner ?? "pool"}${t.pod ? ` · POD-${t.pod}` : ""}) — *${t.flag}*: ${t.detail}`,
    );
  const more = trends.length - lines.length;
  return [
    `*Mailbox health trends — ${date}* (${trends.length} new, alert only: nothing was paused or changed)`,
    ...lines,
    ...(more > 0 ? [`…and ${more} more — GET /mailbox-health/daily?date=${date}`] : []),
  ].join("\n");
}
