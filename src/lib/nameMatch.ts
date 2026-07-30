/**
 * Fuzzy matching for operator-supplied mailbox identifiers.
 *
 * EXTRA_GENERIC_MAILBOXES is typed by a human ("breanna escobar"), while
 * Smartlead carries whatever the mailbox was actually provisioned with —
 * "Bre Escobar", "Breanna  Escobar.", or only an address like
 * bre.escobar@domain.com. Exact string equality misses all of those and the
 * mailbox silently stays exposed to the warmup gate it was meant to skip.
 */

/** Lowercase, strip accents and separators, collapse whitespace. */
export function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[._\-+]+/g, " ")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface NameMatchCandidate {
  /** Smartlead from_name, may be blank. */
  fromName?: string | null;
  /** Mailbox address. */
  email?: string | null;
}

export interface NameMatchResult {
  score: number;
  reason: string;
}

/** Auto-accept at or above this score; below it we only report a suggestion. */
export const MATCH_THRESHOLD = 70;

/**
 * Score how well a candidate matches the wanted identifier.
 * 0 means no relationship at all.
 */
export function scoreNameMatch(
  want: string,
  candidate: NameMatchCandidate,
): NameMatchResult {
  const wanted = normalizeName(want);
  if (!wanted) return { score: 0, reason: "empty" };

  const email = String(candidate.email ?? "").toLowerCase().trim();
  const fromName = normalizeName(String(candidate.fromName ?? ""));
  const local = normalizeName(email.split("@")[0] ?? "");

  if (email && email === want.trim().toLowerCase()) {
    return { score: 100, reason: "exact email" };
  }
  if (fromName && fromName === wanted) {
    return { score: 90, reason: "exact name" };
  }
  if (local && local === wanted) {
    return { score: 80, reason: "email local-part" };
  }

  const wantParts = wanted.split(" ").filter(Boolean);
  if (wantParts.length < 2) {
    // Single token: only accept it as a whole-token hit somewhere.
    if (fromName.split(" ").includes(wanted) || local.split(" ").includes(wanted)) {
      return { score: 70, reason: "single-token match" };
    }
    return { score: 0, reason: "no match" };
  }

  const wantFirst = wantParts[0]!;
  const wantLast = wantParts[wantParts.length - 1]!;

  for (const [label, parts] of [
    ["name", fromName.split(" ").filter(Boolean)],
    ["email", local.split(" ").filter(Boolean)],
  ] as const) {
    if (!parts.length) continue;
    const last = parts[parts.length - 1]!;
    const first = parts[0]!;
    if (last !== wantLast) continue;

    // Surname agrees. Decide on the given name.
    if (first === wantFirst) return { score: 85, reason: `${label} full` };
    if (first.startsWith(wantFirst) || wantFirst.startsWith(first)) {
      // "bre" vs "breanna" — a nickname or truncation.
      return { score: 75, reason: `${label} surname + nickname` };
    }
    if (first[0] === wantFirst[0]) {
      return { score: 70, reason: `${label} surname + initial` };
    }
    // Surname only: suggest, don't auto-accept.
    return { score: 50, reason: `${label} surname only` };
  }

  return { score: 0, reason: "no match" };
}

/** Best candidates for a wanted identifier, highest score first. */
export function rankCandidates<T extends NameMatchCandidate>(
  want: string,
  candidates: T[],
): Array<{ candidate: T; score: number; reason: string }> {
  return candidates
    .map((candidate) => ({ candidate, ...scoreNameMatch(want, candidate) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score);
}
