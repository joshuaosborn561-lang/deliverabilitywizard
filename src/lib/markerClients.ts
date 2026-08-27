/**
 * D142 — Generic and POC are Smartlead CLIENT RECORDS used purely as
 * mailbox pools: a box assigned to one is a generic (staffing supply on
 * the generic clocks), never a client inbox. They take no A/B pods, no
 * floors, no fan-out of their own, and the domain→client audit treats
 * assignment to them as mapped. Pre-warmed is a separate flag entirely
 * (PREWARMED_DOMAINS) that only Josh grants.
 */

export const GENERIC_CLIENT_NAME = "Generic";
export const POC_CLIENT_NAME = "POC";
/** Required by Smartlead's client shape; never mailed. */
export const GENERIC_CLIENT_EMAIL = "generic-pool@salesglidergrowth.com";
export const POC_CLIENT_EMAIL = "poc-pool@salesglidergrowth.com";

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
 * Josh — the audit still never guesses.
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
