/**
 * D160 — Generic and POC are mailbox TAGS, never Smartlead clients.
 * D142 created billable client records named Generic / POC as pool
 * labels; Josh does not want to pay for those. A box carrying either
 * tag is a generic (staffing supply on the generic clocks), never a
 * client inbox. They take no A/B pods, no floors, no fan-out of their
 * own. Pre-warmed is a separate flag (PREWARMED_DOMAINS) that only
 * Josh grants.
 *
 * Leftover Smartlead clients still named Generic / POC (D142) are
 * recognised so we can detach mailboxes and stop recreating them.
 * The names stay here so confident domain matching never treats
 * those leftovers as a real client token.
 */

export const GENERIC_TAG = "GENERIC";
export const POC_TAG = "POC";

/** Leftover D142 client-record names — never create these again. */
export const GENERIC_CLIENT_NAME = "Generic";
export const POC_CLIENT_NAME = "POC";

export function isPoolMarkerTag(name: string | null | undefined): boolean {
  const n = String(name ?? "").trim().toUpperCase();
  return n === GENERIC_TAG || n === POC_TAG;
}

export function hasPoolMarkerTag(account: {
  tags?: Array<{ tag_name?: unknown; name?: unknown }>;
}): boolean {
  return (account.tags ?? [])
    .map((tag) => String(tag.tag_name ?? tag.name ?? "").trim())
    .some((name) => isPoolMarkerTag(name));
}

export function isMarkerClientName(name: string | null | undefined): boolean {
  const n = String(name ?? "").trim().toLowerCase();
  return n === GENERIC_CLIENT_NAME.toLowerCase() || n === POC_CLIENT_NAME.toLowerCase();
}

/** Words too common to identify a client inside a domain name. */
const STOP_TOKENS = new Set([
  "growth",
  "partners",
  "partner",
  "solutions",
  "solution",
  "services",
  "warranty",
  "security",
  "systems",
  "technologies",
  "technology",
  "consulting",
  "company",
  "group",
  "generic",
]);

/**
 * Distinctive lowercase-alnum tokens for a client, drawn from its name and
 * logo: each qualifying word (≥6 chars, not a stop word) plus the full
 * concatenation (so "Culture Fits" yields "culturefits").
 */
export function clientDomainTokens(client: {
  name?: string | null;
  logo?: string | null;
}): string[] {
  if (isMarkerClientName(client.name) || isMarkerClientName(client.logo)) {
    return [];
  }
  const tokens = new Set<string>();
  for (const source of [client.name, client.logo]) {
    const text = String(source ?? "").toLowerCase();
    const words = text.split(/[^a-z0-9]+/).filter(Boolean);
    for (const word of words) {
      if (word.length >= 6 && !STOP_TOKENS.has(word)) tokens.add(word);
    }
    const joined = words.join("");
    if (joined.length >= 6 && !STOP_TOKENS.has(joined)) tokens.add(joined);
  }
  return [...tokens];
}

/**
 * D142 — the confident call: exactly one client whose distinctive token
 * appears in the domain's base name. Anything else stays an advisory for
 * Josh — the audit still never guesses. Leftover Generic/POC client
 * records contribute no tokens (D160).
 */
export function confidentClientForDomain(
  domain: string,
  clients: Array<{ id: number; name?: string | null; logo?: string | null }>,
): { clientId: number; clientName: string } | null {
  const base = domain.toLowerCase().replace(/\.[a-z]+$/i, "").replace(/[^a-z0-9]/g, "");
  if (!base) return null;
  const matches: Array<{ clientId: number; clientName: string }> = [];
  for (const client of clients) {
    const tokens = clientDomainTokens(client);
    if (tokens.some((token) => base.includes(token))) {
      matches.push({
        clientId: client.id,
        clientName: String(client.logo ?? client.name ?? client.id),
      });
    }
  }
  return matches.length === 1 ? matches[0]! : null;
}
