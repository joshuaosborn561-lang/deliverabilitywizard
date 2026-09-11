/**
 * D141 — a bounce pause needs bounces that are REAL and RECENT, not a
 * ledger dump. Smartlead's analytics batch-record old bounces days late
 * (a two-week backlog landed as "12 new bounces in 10 minutes" on
 * 2026-08-27 and paused a healthy 1.9% campaign), so the counter delta
 * alone cannot be trusted:
 *
 * - Burst trip: more than 10 new bounces since the last 10-minute
 *   snapshot — the only trip. The lifetime-rate rule (>10% after 1k,
 *   D90) is retired: Josh's lists are verified before load and never
 *   bounce like that, so the rate rule only ever fired on artifacts.
 * - Recency gate: a tripped burst pauses only when sampled bounced sends
 *   were actually SENT recently. The real failure modes this rule exists
 *   for — a missing send gap machine-gunning, Gmail/Outlook batch-
 *   rejecting a template, a Microsoft tenant blowing its daily cap
 *   (5.7.233) — all bounce fresh sends. A dump of stale bounces logs
 *   loudly and pauses nothing.
 *
 * Smartlead High Bounce Rate Auto Protection is UI-only (D157) — there
 * is no API off-write; attribution is paused_reason "bounce protection".
 */

export const BOUNCE_BURST_COUNT = 10;
/** Cron is every 10 minutes; allow a little drift before the burst window dies. */
export const BOUNCE_BURST_WINDOW_MS = 15 * 60 * 1000;
/** A bounced send older than this cannot be part of a live burst. */
export const BOUNCE_RECENT_SEND_MS = 24 * 60 * 60 * 1000;

export type BouncePauseReason = "burst";

export interface BounceSnapshot {
  bounced: number;
  sent: number;
  at: string;
  /**
   * D162 — fingerprint of the last 5.1.8 NDR scan (sampled row count +
   * newest sent_time). The sender-block path uses this so an unchanged
   * ledger is not re-read every 10 minutes.
   */
  senderBlockHint?: string;
}

/** More than 10 new bounces inside the last ~10-minute snapshot window. */
export function shouldPauseCampaignForBounceBurst(
  previous: BounceSnapshot | undefined,
  bounced: number,
  nowMs = Date.now(),
  burstCount = BOUNCE_BURST_COUNT,
  windowMs = BOUNCE_BURST_WINDOW_MS,
): { trip: boolean; delta: number } {
  if (!previous) return { trip: false, delta: 0 };
  const at = Date.parse(previous.at);
  if (!Number.isFinite(at) || nowMs - at > windowMs) {
    return { trip: false, delta: 0 };
  }
  const delta = bounced - previous.bounced;
  return { trip: delta > burstCount, delta };
}

export interface BounceRecencyRead {
  /** Rows that carried a parseable sent_time. */
  readable: number;
  /** Rows whose send happened inside the recency window. */
  fresh: number;
  /** ISO of the newest sampled send, for the log line. */
  newestSentAt: string | null;
}

/**
 * D141 — read sent_time off sampled bounced-send rows and split live
 * bounces from ledger residue. Rows are the Smartlead statistics shape
 * (email_status=bounced); anything without a parseable sent_time is
 * ignored rather than guessed at.
 */
export function freshBounceSamples(
  rows: Array<Record<string, unknown>>,
  nowMs = Date.now(),
  recentMs = BOUNCE_RECENT_SEND_MS,
): BounceRecencyRead {
  let readable = 0;
  let fresh = 0;
  let newest: number | null = null;
  for (const row of rows) {
    const sentAt = Date.parse(String(row.sent_time ?? ""));
    if (!Number.isFinite(sentAt)) continue;
    readable += 1;
    if (newest == null || sentAt > newest) newest = sentAt;
    if (nowMs - sentAt <= recentMs) fresh += 1;
  }
  return {
    readable,
    fresh,
    newestSentAt: newest == null ? null : new Date(newest).toISOString(),
  };
}
