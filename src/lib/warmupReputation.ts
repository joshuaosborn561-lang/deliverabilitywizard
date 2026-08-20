/**
 * Warmup reputation as an independent rotation signal (D42).
 *
 * A sender currently comes off active campaigns on two signals: same-ESP
 * placement below `REMEDIATION_INBOX_THRESHOLD` (D32/D5), or bounce above
 * `BOUNCE_RATE_THRESHOLD` once it has sent `MIN_BOUNCE_SAMPLE`. Smartlead's own
 * warmup reputation is converged on every mailbox each run but is never read as
 * health, and a badly damaged mailbox trips neither existing signal: it is
 * barely delivering, so its bounce rate stays clean, and it only fails
 * placement once a seeded test happens to cover it.
 *
 * Measured 2026-08-20 across every ACTIVE campaign — grouping SalesGlider
 * senders from placement tests #507468/#507469 by current reputation:
 *
 *   98-100%   49 mailboxes  3,014 seeds   86% inbox
 *   90-97%     3 mailboxes    134 seeds   38% inbox
 *   below 90%  8 mailboxes    310 seeds   36% inbox
 *
 * The same split holds per client pool: SalesGlider carries 11 mailboxes under
 * 98% and places 22% on Gmail; BCP carries 1 and places 79%; Vasco and Peterson
 * carry none and place 97% and 99%. Reputation separated the pools where sender
 * host, mailbox age and copy all failed to.
 *
 * Caveat, deliberately not hidden: reputation was read after those tests ran, so
 * this is a correlation and low reputation may be a *consequence* of poor
 * placement rather than its cause. Either way a mailbox reading 36% inbox
 * belongs off campaigns — reputation is what surfaces it weeks before a
 * placement test would.
 */

/** Anything carrying Smartlead's warmup block. */
export interface WarmupBearing {
  warmup_details?: { warmup_reputation?: number | string } | null;
}

/**
 * Reputation as a 0-100 number, or null when absent/unparseable.
 *
 * Smartlead returns this as a percent-suffixed string ("99%") on the campaign
 * email-accounts route and as a bare number elsewhere. `null` and `undefined`
 * both mean "no reading" and must never be coerced to 0 — a missing value is
 * not a damaged mailbox, and treating it as one would bench every account the
 * API happened to answer thinly for.
 */
export function parseWarmupReputation(account: WarmupBearing | null | undefined): number | null {
  const raw = account?.warmup_details?.warmup_reputation;
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  const trimmed = String(raw).trim().replace(/%$/, "");
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * True when a mailbox's warmup reputation is low enough to pull it.
 *
 * `threshold <= 0` disables the signal entirely, matching how the other
 * rotation switches turn off. A null reading never rotates.
 */
export function shouldRotateForWarmupReputation(
  reputation: number | null,
  threshold: number,
): boolean {
  if (!Number.isFinite(threshold) || threshold <= 0) return false;
  if (reputation === null) return false;
  return reputation < threshold;
}

/**
 * Damaged senders keyed by lowercased email, value = the reputation reading.
 *
 * Built from accounts already in memory, so this costs no extra API calls —
 * part of why the signal is cheap enough to check on every pass.
 */
export function collectWarmupReputationRotations<
  T extends WarmupBearing & { from_email?: string | null },
>(accounts: readonly T[], threshold: number): Map<string, number> {
  const out = new Map<string, number>();
  if (!Number.isFinite(threshold) || threshold <= 0) return out;
  for (const account of accounts) {
    const email = account.from_email?.trim().toLowerCase();
    if (!email) continue;
    const reputation = parseWarmupReputation(account);
    if (shouldRotateForWarmupReputation(reputation, threshold)) {
      out.set(email, reputation as number);
    }
  }
  return out;
}
