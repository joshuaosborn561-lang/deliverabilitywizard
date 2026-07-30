import type { BlacklistedDomainHit } from "../types/index.js";

export type BlacklistVerdict =
  /** The sending domain itself is listed — the domain is burned. */
  | "domain_burned"
  /** The listed IP carries several of our domains — shared/provider IP problem. */
  | "shared_ip"
  /** Only this domain's sending IP is listed, domain itself is clean. */
  | "domain_ip"
  | "unclear";

export interface BlacklistDiagnosis {
  domain: string;
  fromEmail?: string;
  verdict: BlacklistVerdict;
  /** Plain-English why. */
  reason: string;
  /** What to actually do about it. */
  recommendation: string;
  /** Named blocklists it appears on, e.g. Spamhaus ZEN. */
  listings: string[];
  ips: string[];
  /** Other sending domains sharing a listed IP with this one. */
  sharedWithDomains: string[];
  totalHits: number;
}

/**
 * Separate "this domain is burned" from "InboxKit put us on a dirty shared IP".
 *
 * The distinguishing signal is whether a single listed IP carries more than one
 * of our sending domains: a burned domain is listed on its own, whereas a bad
 * shared IP drags every domain behind it onto the same list at once. Replacing
 * domains does nothing in the shared-IP case — the IP has to be changed.
 */
export function diagnoseBlacklists(
  hits: BlacklistedDomainHit[],
): BlacklistDiagnosis[] {
  // Which sending domains sit behind each listed IP
  const domainsByIp = new Map<string, Set<string>>();
  for (const hit of hits) {
    if (!hit.ip) continue;
    const set = domainsByIp.get(hit.ip) ?? new Set<string>();
    set.add(hit.domain.toLowerCase());
    domainsByIp.set(hit.ip, set);
  }

  const byDomain = new Map<string, BlacklistedDomainHit[]>();
  for (const hit of hits) {
    const key = hit.domain.toLowerCase();
    const list = byDomain.get(key) ?? [];
    list.push(hit);
    byDomain.set(key, list);
  }

  const out: BlacklistDiagnosis[] = [];

  for (const [domain, domainHits] of byDomain) {
    const listings = [
      ...new Set(
        domainHits
          .map((h) => h.listName?.trim())
          .filter((x): x is string => Boolean(x)),
      ),
    ];
    const ips = [
      ...new Set(
        domainHits.map((h) => h.ip?.trim()).filter((x): x is string => Boolean(x)),
      ),
    ];
    const totalHits = domainHits.reduce((sum, h) => sum + (h.totalHits ?? 0), 0);
    const fromEmail = domainHits.find((h) => h.fromEmail)?.fromEmail;

    const sharedWith = new Set<string>();
    for (const ip of ips) {
      for (const other of domainsByIp.get(ip) ?? []) {
        if (other !== domain) sharedWith.add(other);
      }
    }

    const domainListed = domainHits.some(
      (h) => h.source === "domain-blacklist",
    );
    const ipListed = domainHits.some((h) => h.source === "ip-blacklist");

    let verdict: BlacklistVerdict;
    let reason: string;
    let recommendation: string;

    if (domainListed) {
      verdict = "domain_burned";
      reason = `The sending domain itself is on ${describeListings(listings)}. That is a reputation hit against the domain, not the IP.`;
      recommendation = `Treat \`${domain}\` as burned — delete its mailboxes and replace the domain. Do not reuse it.`;
    } else if (ipListed && sharedWith.size > 0) {
      verdict = "shared_ip";
      reason = `The domain is clean, but its sending IP ${ips.join(", ")} is listed on ${describeListings(listings)} — and that same IP also carries ${sharedWith.size} other sending domain(s) of ours (${[...sharedWith].slice(0, 5).join(", ")}). That is a shared-IP problem on the provider side.`;
      recommendation = `Do NOT replace the domain — it is not burned. Raise the listed IP with InboxKit and ask to be moved to a clean IP; replacing domains behind the same IP will not fix placement.`;
    } else if (ipListed) {
      verdict = "domain_ip";
      reason = `The domain is not listed, but its sending IP ${ips.join(", ")} is on ${describeListings(listings)}. No other domain of ours shares that IP.`;
      recommendation = `Check with InboxKit whether this IP is dedicated to \`${domain}\`. If it is dedicated, the domain's own sending got it listed — warm down and consider replacing. If it is shared with other tenants, request an IP move.`;
    } else {
      verdict = "unclear";
      reason = `Flagged as blacklisted but the report did not say whether the domain or the IP is listed.`;
      recommendation = `Open the SmartDelivery blacklist report for \`${domain}\` and confirm manually before replacing anything.`;
    }

    out.push({
      domain,
      fromEmail,
      verdict,
      reason,
      recommendation,
      listings,
      ips,
      sharedWithDomains: [...sharedWith].sort(),
      totalHits,
    });
  }

  return out.sort((a, b) => a.domain.localeCompare(b.domain));
}

function describeListings(listings: string[]): string {
  if (!listings.length) return "a blocklist";
  if (listings.length === 1) return `the ${listings[0]} blocklist`;
  return `${listings.length} blocklists (${listings.slice(0, 4).join(", ")})`;
}

/**
 * Domains safe to auto-replace. Shared-IP listings are excluded on purpose:
 * burning and rebuying domains behind a dirty IP costs money and fixes nothing.
 */
export function domainsSafeToReplace(
  diagnoses: BlacklistDiagnosis[],
): string[] {
  return diagnoses
    .filter((d) => d.verdict === "domain_burned")
    .map((d) => d.domain);
}
