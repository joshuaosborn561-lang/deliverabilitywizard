import type { SenderInboxRate } from "../clients/smartdelivery.js";

/**
 * D32 — Placement rotation never uses a blended (all-ESP) inbox score.
 *
 * When same-ESP scoring is on, a sender is only placement-rotatable if the
 * decision rate was computed from enough same-ESP seeds. Thin samples or
 * mailbox-summary blends are informational only — bounce remains a separate
 * signal.
 */
export function shouldRotateForPlacement(
  row: Pick<SenderInboxRate, "inboxRate" | "scoredSameEsp"> | undefined,
  threshold: number,
  opts: { scoreSameEspOnly: boolean },
): boolean {
  if (!row || typeof row.inboxRate !== "number") return false;
  if (opts.scoreSameEspOnly && row.scoredSameEsp !== true) return false;
  return row.inboxRate < threshold;
}

/**
 * When merging sender rows across tests, never let a blended row replace a
 * same-ESP row (D32). Among equal eligibility, keep the worse inbox %.
 */
export function preferSenderInboxRate(
  prev: SenderInboxRate | undefined,
  next: SenderInboxRate,
  opts: { scoreSameEspOnly: boolean },
): SenderInboxRate {
  if (!prev) return next;
  if (opts.scoreSameEspOnly) {
    if (next.scoredSameEsp && !prev.scoredSameEsp) return next;
    if (!next.scoredSameEsp && prev.scoredSameEsp) return prev;
  }
  return next.inboxRate < prev.inboxRate ? next : prev;
}
