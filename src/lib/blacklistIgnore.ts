/**
 * Blocklists that should never trigger domain teardown / replace.
 *
 * SURBL is a URI reputation list — SmartDelivery's domain-blacklist boolean
 * often lights up for SURBL (and similar) without naming the list. Josh:
 * omit SURBL from destructive remediation; low inbox-rate rotation already
 * covers actually-bad senders.
 */
/** Named lists we ignore for teardown. */
export function isIgnoredBlacklistName(
  listName?: string | null,
  details?: string | null,
): boolean {
  const blob = `${listName ?? ""} ${details ?? ""}`.trim();
  if (!blob) return false;
  // SURBL (+ URIBL family) — noisy URI reputation, not grounds to burn a domain.
  return /surbl/i.test(blob) || /uribl/i.test(blob);
}

/**
 * SmartDelivery's /domain-blacklist endpoint only returns
 * `domain_blacklisted: true` with no list name. In practice that flag is the
 * noisy SURBL/URI-list signal. Without a concrete non-SURBL list name we do
 * not treat the hit as teardown-worthy.
 */
export function isTeardownIgnoredBlacklistHit(hit: {
  source: string;
  listName?: string | null;
  details?: string | null;
}): boolean {
  if (isIgnoredBlacklistName(hit.listName, hit.details)) return true;
  if (hit.source === "domain-blacklist" && !hit.listName?.trim()) {
    return true;
  }
  return false;
}
