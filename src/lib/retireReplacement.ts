/**
 * D161 — a client-domain retire buys a client-named replacement.
 *
 * The D150 stock path used to spin from `isolationBuyParentDomain`
 * (default `crosslaunchco.com`) for every retire. That bought
 * crosslaunchcotry.info when Josh retired boldercyperpartnerpro.info
 * (BCP). Generic / pool spins stay valid only when the retired domain
 * itself is generic.
 */
import { GENERIC_POOL_PLAN } from "../data/genericPoolPlan.js";
import { isBcpOwnedDomain } from "./bcp.js";
import { isGenericPoolDomain } from "./clientInbox.js";
import {
  brandRootFromParent,
  DOMAIN_AFFIXES,
  type DomainSpin,
} from "./domainNaming.js";

export type RetireReplacementConfig = {
  isolationBuyParentDomain: string;
  extraGenericDomains: string[];
  prewarmedDomains: string[];
};

const WELL_KNOWN_GENERIC_PARENTS = [
  "crosslaunchco.com",
  "crossscaleco.com",
  "cleartechco.com",
] as const;

/** BCP's standing brand token — already used on get/try/key/pro spins. */
const BCP_BRAND = "boldercyperpartner";

export function stripKnownAffixes(root: string): string {
  let current = root.trim().toLowerCase();
  let changed = true;
  while (changed && current.length) {
    changed = false;
    for (const affix of DOMAIN_AFFIXES) {
      if (current.startsWith(affix) && current.length - affix.length >= 6) {
        current = current.slice(affix.length);
        changed = true;
        break;
      }
      if (current.endsWith(affix) && current.length - affix.length >= 6) {
        current = current.slice(0, -affix.length);
        changed = true;
        break;
      }
    }
  }
  return current;
}

/**
 * Brand used to spin the replacement. Strips TLD + known get/try/pro
 * affixes so boldercyperpartnerpro.info → boldercyperpartner (the style
 * already on that client's inventory).
 */
export function replacementBrandRoot(domain: string): string {
  const lower = domain.trim().toLowerCase();
  if (lower.includes(BCP_BRAND) || isBcpOwnedDomain(lower)) return BCP_BRAND;
  return stripKnownAffixes(brandRootFromParent(lower));
}

function leftoverIsOnlyAffixes(value: string): boolean {
  if (!value) return true;
  let rest = value;
  let changed = true;
  while (changed && rest) {
    changed = false;
    for (const affix of DOMAIN_AFFIXES) {
      if (rest.startsWith(affix)) {
        rest = rest.slice(affix.length);
        changed = true;
        break;
      }
    }
  }
  return rest.length === 0;
}

/** Distinctive generic-pool brand tokens (crosslaunchco, meetconnect, …). */
export function genericBrandRoots(config: RetireReplacementConfig): Set<string> {
  const roots = new Set<string>();
  const add = (value: string | undefined) => {
    const raw = brandRootFromParent(value ?? "");
    if (raw.length >= 6) roots.add(raw);
  };
  add(config.isolationBuyParentDomain);
  for (const domain of config.extraGenericDomains) add(domain);
  for (const domain of config.prewarmedDomains) add(domain);
  for (const known of WELL_KNOWN_GENERIC_PARENTS) add(known);
  for (const row of GENERIC_POOL_PLAN.domains) {
    add(row.domain);
    add(row.parent);
  }
  return roots;
}

export function isGenericBrandName(
  domain: string,
  roots: Set<string>,
): boolean {
  const base = brandRootFromParent(domain);
  if (!base) return false;
  for (const root of roots) {
    if (!root || root.length < 6) continue;
    if (base === root) return true;
    const idx = base.indexOf(root);
    if (idx === -1) continue;
    const leftover = base.slice(0, idx) + base.slice(idx + root.length);
    if (leftoverIsOnlyAffixes(leftover)) return true;
  }
  return false;
}

/**
 * True when this sending domain is generic/pool inventory — those
 * replacements MAY be generic spins. Everything else is a client domain
 * (fail closed): BCP, a named-client brand, or an unknown domain.
 */
export function isGenericSendingDomain(
  domain: string,
  config: RetireReplacementConfig,
): boolean {
  const host = domain.trim().toLowerCase();
  if (!host) return false;
  if (isGenericPoolDomain(host)) return true;
  if (config.extraGenericDomains.includes(host)) return true;
  if (config.prewarmedDomains.includes(host)) return true;
  if (isGenericBrandName(host, genericBrandRoots(config))) return true;
  return false;
}

export function isClientSendingDomain(
  domain: string,
  config: RetireReplacementConfig,
): boolean {
  const host = domain.trim().toLowerCase();
  if (!host) return false;
  return !isGenericSendingDomain(host, config);
}

/**
 * Parent fed to `generateDomainSpins` for a replacement buy.
 *
 * Isolation-rig / canary buys (no retired client domain) keep the
 * generic parent. A client-domain replace NEVER returns a generic
 * parent — it throws rather than fall through to crosslaunchco.
 */
export function replacementParentForRetiredDomain(
  sourceDomain: string,
  config: RetireReplacementConfig,
  opts: { requestedParent?: string; kind?: string } = {},
): string {
  const kind = opts.kind ?? "";
  const requested = (opts.requestedParent ?? "").trim().toLowerCase();
  const source = sourceDomain.trim().toLowerCase();

  if (
    kind === "buy_isolation_domain" ||
    kind === "buy_canary_fleet" ||
    !source
  ) {
    return requested || config.isolationBuyParentDomain;
  }

  if (isGenericSendingDomain(source, config)) {
    return requested || config.isolationBuyParentDomain;
  }

  const brand = replacementBrandRoot(source);
  if (!brand || brand.length < 6) {
    throw new Error(
      `Cannot derive a client brand from ${source}; refusing a generic replacement (D161).`,
    );
  }
  const parent = `${brand}.info`;
  if (isGenericSendingDomain(parent, config) || isGenericBrandName(parent, genericBrandRoots(config))) {
    throw new Error(
      `Client domain ${source} resolved to generic parent ${parent}; refusing (D161).`,
    );
  }
  return parent;
}

/** True when this candidate would repeat tonight's incident. */
export function isForbiddenGenericReplacement(
  sourceDomain: string,
  candidateDomain: string,
  config: RetireReplacementConfig,
): boolean {
  if (!isClientSendingDomain(sourceDomain, config)) return false;
  return isGenericSendingDomain(candidateDomain, config);
}

export function filterReplacementSpins(
  spins: DomainSpin[],
  sourceDomain: string,
  config: RetireReplacementConfig,
  owned: Set<string>,
): DomainSpin[] {
  const source = sourceDomain.trim().toLowerCase();
  const clientReplace = isClientSendingDomain(source, config);
  return spins.filter((spin) => {
    const host = spin.domain.toLowerCase();
    if (owned.has(host)) return false;
    if (source && host === source) return false;
    if (clientReplace && isGenericSendingDomain(host, config)) return false;
    return true;
  });
}
