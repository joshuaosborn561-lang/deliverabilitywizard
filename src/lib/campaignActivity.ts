/**
 * Should a campaign get a placement test at all? (D41)
 *
 * The scanner's eligibility filter checks campaign *status* only. A Smartlead
 * campaign stays ACTIVE after its list is fully worked, so a campaign that has
 * nothing left to send still looks like a live campaign and still earns a
 * recurring placement test. Those tests keep seeding forever against a campaign
 * whose real sending stopped weeks ago.
 *
 * On 2026-08-20 that was 24 of 47 ACTIVE tests — half the running tests — spread
 * over 11 campaigns with zero uncontacted leads, one of which (MSRS2) had not
 * sent since 2026-07-20. Because SmartDelivery has no delete endpoint and the
 * quota counts every test row regardless of status, slots consumed this way are
 * never recovered.
 *
 * Recent send volume is the gate rather than a lead-exhaustion count: it is one
 * `analytics-by-date` range call per campaign instead of paginating tens of
 * thousands of leads, and it captures the thing we actually care about — a
 * placement test measures nothing when no mail is flowing.
 */

/** Inclusive UTC date window ending today, `days` long. */
export function idleWindow(
  days: number,
  now: Date = new Date(),
): { startDate: string; endDate: string } {
  const span = Math.max(1, Math.trunc(days));
  const end = new Date(now.getTime());
  const start = new Date(now.getTime() - (span - 1) * 86_400_000);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

/**
 * Sends reported in the window. Smartlead returns counts as strings on some
 * routes, and omits them entirely for a campaign that never sent.
 */
export function sentCountOf(analytics: { sent_count?: number | string } | null | undefined): number {
  const raw = analytics?.sent_count;
  const n = typeof raw === "string" ? Number(raw) : raw;
  return Number.isFinite(n) ? Number(n) : 0;
}

/**
 * True when the campaign has sent nothing in the window and should not consume
 * a placement-test slot.
 *
 * `idleDays <= 0` disables the gate, so the behaviour can be turned off with
 * config alone if a campaign type ever needs testing while dormant.
 */
export function isIdleCampaign(
  analytics: { sent_count?: number | string } | null | undefined,
  idleDays: number,
): boolean {
  if (!Number.isFinite(idleDays) || idleDays <= 0) return false;
  return sentCountOf(analytics) === 0;
}
