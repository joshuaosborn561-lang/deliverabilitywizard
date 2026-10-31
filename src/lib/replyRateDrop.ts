/**
 * D311 — reply-rate-drop trigger (LOCKED canon, Josh 2026-10-29).
 *
 * Flag a sending DOMAIN when its trailing 7-day reply rate, with at least
 * 150 sends in that window, is 40% or more below the client's baseline
 * (the client's trailing 30-day reply rate across ACTIVE campaigns).
 *
 * Alert-only: Josh is alerted, then one placement test runs on that
 * domain's mailboxes. Nothing is pulled, paused, rested or isolated. It
 * sits on top of the placement gates and does not replace them.
 */
import { extractRows } from "./bounceRate.js";

export const REPLY_DROP_MIN_SENDS = 150;
/** Flag at or beyond this fractional drop below baseline (0.4 = 40%). */
export const REPLY_DROP_THRESHOLD = 0.4;
export const REPLY_DROP_WINDOW_DAYS = 7;
export const REPLY_DROP_BASELINE_DAYS = 30;
/** Do not re-alert the same domain inside this window. */
export const REPLY_DROP_REALERT_MS = 7 * 24 * 60 * 60 * 1000;

export interface SenderReplyStats {
  email: string;
  sent: number;
  replied: number;
}

const EMAIL_KEYS = ["email", "from_email", "email_account", "account_email"];
const SENT_KEYS = ["sent_count", "sent", "total_sent", "emails_sent", "total_count"];
const REPLY_KEYS = ["reply_count", "replied_count", "replied", "total_replied", "total_replies"];

function pickNum(row: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const v = row[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
      return Number(v);
    }
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

/** Per-mailbox sent / replied counts out of a name-wise health-metrics payload. */
export function parseSenderReplyStats(payload: unknown): SenderReplyStats[] {
  const out = new Map<string, SenderReplyStats>();
  for (const row of extractRows(payload)) {
    const email = pickStr(row, EMAIL_KEYS)?.toLowerCase();
    if (!email || !email.includes("@")) continue;
    const sent = pickNum(row, SENT_KEYS);
    const replied = pickNum(row, REPLY_KEYS);
    if (sent === null || replied === null || sent < 0 || replied < 0) continue;
    const prev = out.get(email);
    out.set(email, {
      email,
      sent: (prev?.sent ?? 0) + sent,
      replied: (prev?.replied ?? 0) + replied,
    });
  }
  return [...out.values()];
}

export function domainOfEmail(email: string): string {
  return email.trim().toLowerCase().split("@")[1] ?? "";
}

export interface ReplyDropMailbox {
  email: string;
  clientId: number;
}

export interface ReplyDropFinding {
  domain: string;
  clientId: number;
  mailboxes: string[];
  sent7: number;
  replied7: number;
  /** Percent, 0-100. */
  rate7: number;
  baselineRate: number;
  baselineSent: number;
  /** Percent below baseline, 0-100. */
  dropPercent: number;
}

/**
 * Pure decision. `mailboxes` are the sending mailboxes of ACTIVE
 * campaigns with their client. Baseline = that client's 30-day
 * replied / sent over those mailboxes. A domain is flagged only with
 * >= minSends in the 7-day window, a baseline above zero, and a 7-day
 * rate at least `threshold` below it.
 */
export function evaluateReplyRateDrop(input: {
  mailboxes: ReplyDropMailbox[];
  stats7: SenderReplyStats[];
  stats30: SenderReplyStats[];
  minSends?: number;
  threshold?: number;
}): ReplyDropFinding[] {
  const minSends = input.minSends ?? REPLY_DROP_MIN_SENDS;
  const threshold = input.threshold ?? REPLY_DROP_THRESHOLD;
  const s7 = new Map(input.stats7.map((s) => [s.email.toLowerCase(), s]));
  const s30 = new Map(input.stats30.map((s) => [s.email.toLowerCase(), s]));

  const baselines = new Map<number, { sent: number; replied: number }>();
  const domains = new Map<
    string,
    { clientId: number; mailboxes: string[]; sent7: number; replied7: number }
  >();
  for (const box of input.mailboxes) {
    const email = box.email.toLowerCase();
    const b = baselines.get(box.clientId) ?? { sent: 0, replied: 0 };
    const m30 = s30.get(email);
    if (m30) {
      b.sent += m30.sent;
      b.replied += m30.replied;
    }
    baselines.set(box.clientId, b);

    const domain = domainOfEmail(email);
    if (!domain) continue;
    const key = `${box.clientId}|${domain}`;
    const d = domains.get(key) ?? {
      clientId: box.clientId,
      mailboxes: [],
      sent7: 0,
      replied7: 0,
    };
    d.mailboxes.push(email);
    const m7 = s7.get(email);
    if (m7) {
      d.sent7 += m7.sent;
      d.replied7 += m7.replied;
    }
    domains.set(key, d);
  }

  const findings: ReplyDropFinding[] = [];
  for (const [key, d] of domains) {
    if (d.sent7 < minSends) continue;
    const base = baselines.get(d.clientId);
    if (!base || base.sent <= 0) continue;
    const baselineRate = (base.replied / base.sent) * 100;
    if (!(baselineRate > 0)) continue;
    const rate7 = (d.replied7 / d.sent7) * 100;
    const dropPercent = ((baselineRate - rate7) / baselineRate) * 100;
    if (dropPercent < threshold * 100) continue;
    findings.push({
      domain: key.split("|")[1]!,
      clientId: d.clientId,
      mailboxes: d.mailboxes,
      sent7: d.sent7,
      replied7: d.replied7,
      rate7,
      baselineRate,
      baselineSent: base.sent,
      dropPercent,
    });
  }
  return findings.sort((a, b) => b.dropPercent - a.dropPercent);
}

export function replyDropAlertText(f: ReplyDropFinding): string {
  return (
    `:chart_with_downwards_trend: *Reply-rate drop on ${f.domain}* (client ${f.clientId}). ` +
    `Last 7 days ${f.rate7.toFixed(2)}% reply on ${f.sent7} sends vs the client's 30-day baseline ` +
    `${f.baselineRate.toFixed(2)}%, ${f.dropPercent.toFixed(0)}% below (flag at ${REPLY_DROP_THRESHOLD * 100}%+ with ${REPLY_DROP_MIN_SENDS}+ sends). ` +
    `Alert only: a placement test is running on this domain's ${f.mailboxes.length} mailbox(es). Nothing is pulled or paused.`
  );
}
