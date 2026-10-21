/**
 * D297 — scan-backfill walks the board (20m step). Starting it when
 * the 45-minute health lock has less than that remaining lets a hung
 * scan get taken over and skip the next pass as already-running.
 */

export const SCAN_BACKFILL_MIN_REMAINING_MS = 20 * 60 * 1000;

export function shouldSkipScanBackfillForLockBudget(
  remainingLockMs: number,
  minRemainingMs = SCAN_BACKFILL_MIN_REMAINING_MS,
): boolean {
  return remainingLockMs < minRemainingMs;
}

export function scanBackfillBudgetSkipReason(remainingLockMs: number): string {
  const minutes = Math.max(0, Math.round(remainingLockMs / 60_000));
  return `skip — ${minutes}m remain in 45m health lock`;
}
