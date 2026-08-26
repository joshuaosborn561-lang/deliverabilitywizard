/**
 * D90 — pause an ACTIVE campaign when bounce is real, not on the old 20/7
 * bands (D88). Two independent trips:
 *
 * - Rate: more than 10% bounce after 1,000 leads emailed (lifetime sent).
 * - Burst: more than 10 new bounces since the last 10-minute snapshot.
 *
 * Smartlead bounce_autopause_threshold stays off at 100. D29 still
 * investigates an already-PAUSED campaign over 7%.
 */

export const BOUNCE_PAUSE_MIN_LEADS = 1000;
export const BOUNCE_PAUSE_RATE_PERCENT = 10;
export const BOUNCE_BURST_COUNT = 10;
/** Cron is every 10 minutes; allow a little drift before the burst window dies. */
export const BOUNCE_BURST_WINDOW_MS = 15 * 60 * 1000;

export type BouncePauseReason = "rate" | "burst";

export interface BounceSnapshot {
  bounced: number;
  sent: number;
  at: string;
}

/** Strictly over 10% after 1k sent. 100/1000 is 10% and must not pause. */
export function shouldPauseCampaignForBounceRate(
  sent: number,
  bounces: number,
  minLeads = BOUNCE_PAUSE_MIN_LEADS,
  ratePercent = BOUNCE_PAUSE_RATE_PERCENT,
): boolean {
  if (sent < minLeads || sent <= 0) return false;
  return bounces * 100 > ratePercent * sent;
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
