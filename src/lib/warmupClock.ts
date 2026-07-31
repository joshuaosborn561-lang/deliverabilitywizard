/**
 * Which timestamp counts as "warmup started".
 *
 * The pool used to stamp its own clock at the moment a mailbox was first
 * written into state, so rebuilding state — or importing mailboxes that had
 * been warming for weeks — restarted a fresh 14 days and held ready senders
 * back. Smartlead knows when warmup actually began; that date wins.
 */

/**
 * Earliest valid timestamp among the candidates, which is the true warmup
 * age. Invalid and future dates are ignored; a future date would mean a
 * mailbox never becomes available.
 */
export function earliestWarmupStart(
  ...candidates: Array<string | null | undefined>
): string {
  const now = Date.now();
  let best: number | null = null;

  for (const candidate of candidates) {
    if (!candidate) continue;
    const parsed = Date.parse(candidate);
    if (!Number.isFinite(parsed)) continue;
    // Tolerate small clock skew, reject anything meaningfully ahead.
    if (parsed > now + 60_000) continue;
    if (best === null || parsed < best) best = parsed;
  }

  return new Date(best ?? now).toISOString();
}
