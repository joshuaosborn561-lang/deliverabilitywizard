/**
 * Blocklists that should never count as a hit (D210) and those that
 * must not trigger domain teardown / replace.
 *
 * SURBL is a URI reputation list — many of our sending domains land on
 * multi.surbl.org (127.0.0.64) and it barely affects delivery. Josh:
 * SURBL (any *.surbl.org zone) never counts as a blacklist hit. It may
 * still be logged as info-only. SmartDelivery's domain-blacklist boolean
 * often lights up for SURBL without naming the list; treat that the
 * same way.
 */

/** SURBL product name or any *.surbl.org zone — never a countable hit (D210). */
export function isSurblListing(
  listName?: string | null,
  details?: string | null,
): boolean {
  const blob = `${listName ?? ""} ${details ?? ""}`.trim();
  if (!blob) return false;
  return /\.surbl\.org\b/i.test(blob) || /\bsurbl\b/i.test(blob);
}

/** Named lists we ignore for teardown. SURBL never counts; URIBL stays teardown-only. */
export function isIgnoredBlacklistName(
  listName?: string | null,
  details?: string | null,
): boolean {
  const blob = `${listName ?? ""} ${details ?? ""}`.trim();
  if (!blob) return false;
  if (isSurblListing(listName, details)) return true;
  // URIBL family — still ignored for teardown / replace, still a named listing.
  return /uribl/i.test(blob);
}

/**
 * A listing that may drive an alert, retire, teardown, or infra "listed" count.
 * SURBL and unnamed SmartDelivery domain-blacklist flags are info-only (D210).
 */
export function isCountableBlacklistHit(hit: {
  source: string;
  listName?: string | null;
  details?: string | null;
}): boolean {
  if (isSurblListing(hit.listName, hit.details)) return false;
  if (hit.source === "domain-blacklist" && !hit.listName?.trim()) {
    return false;
  }
  return true;
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

/** Drop SURBL (and unnamed SmartDelivery domain-blacklist) before hit counts. */
export function filterCountableBlacklistHits<
  T extends {
    source: string;
    listName?: string | null;
    details?: string | null;
  },
>(hits: T[]): T[] {
  return hits.filter((hit) => isCountableBlacklistHit(hit));
}
