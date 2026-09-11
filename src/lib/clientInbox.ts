import type { AppConfig } from "../config.js";
import { GENERIC_POOL_PLAN } from "../data/genericPoolPlan.js";
import type { StateStore } from "../state/store.js";
import type { SmartleadEmailAccount } from "../types/index.js";
import { isBcpOwnedDomain } from "./bcp.js";
import { emailDomainOf } from "./isolationDomain.js";
import { hasPoolMarkerTag } from "./markerClients.js";
import { isPrewarmedGeneric } from "../services/warmupGate.js";

const droppedPoolDomains =
  (
    GENERIC_POOL_PLAN as {
      expansion?: { droppedDomains?: string[] };
    }
  ).expansion?.droppedDomains ?? [];

const POOL_PLAN_DOMAINS = new Set(
  [
    ...GENERIC_POOL_PLAN.domains.map((row) => row.domain),
    ...droppedPoolDomains,
  ].map((domain) => domain.trim().toLowerCase()),
);

/**
 * Pool-brand tokens that mark a sending domain as generic even when the
 * exact host is missing from the frozen plan / EXTRA_GENERIC list
 * (getintroduced* / quickconnect* / appquickconnect* variants).
 * BCP-named domains are exempted earlier in isGenericMailbox (D169).
 */
const GENERIC_POOL_BRAND_TOKENS = [
  "getintroduced",
  "quickconnect",
  "appquickconnect",
  "meetconnect",
  "outreachdesk",
] as const;

/** True when the sending domain is in the InboxKit generic-pool plan. */
export function isGenericPoolDomain(domain: string | undefined): boolean {
  if (!domain) return false;
  return POOL_PLAN_DOMAINS.has(domain.trim().toLowerCase());
}

/** True when the host carries a known generic-pool brand token. */
export function isGenericPoolBrandDomain(domain: string | undefined): boolean {
  if (!domain) return false;
  const host = domain.trim().toLowerCase();
  if (!host) return false;
  const base = host.replace(/\.[a-z0-9]+$/i, "").replace(/[^a-z0-9]/g, "");
  if (!base) return false;
  return GENERIC_POOL_BRAND_TOKENS.some((token) => base.includes(token));
}

/**
 * A client inbox belongs to a Smartlead client and is not a pool generic
 * or a pre-warmed fleet sender. Only these take the per-client A/B rest
 * (D43). Generics fill to 50 and rest on a 2-week send clock.
 */
export function isClientInbox(
  account: Pick<SmartleadEmailAccount, "client_id" | "from_name" | "tags">,
  email: string,
  config: Pick<AppConfig, "extraGenericMailboxes" | "extraGenericDomains" | "prewarmedDomains">,
  state: Pick<StateStore, "getPoolMailbox">,
): boolean {
  const normalized = email.trim().toLowerCase();
  if (!normalized.includes("@")) return false;
  if (isGenericMailbox(account, normalized, config, state)) return false;
  if (typeof account.client_id === "number" && Number.isFinite(account.client_id)) {
    return true;
  }
  return false;
}

/** A/B rest is client inboxes only (D43). Generics use the send clock. */
export function isRestEligibleMailbox(
  account: Pick<SmartleadEmailAccount, "client_id" | "from_name" | "tags">,
  email: string,
  config: Pick<AppConfig, "extraGenericMailboxes" | "extraGenericDomains" | "prewarmedDomains">,
  state: Pick<StateStore, "getPoolMailbox">,
): boolean {
  return isClientInbox(account, email, config, state);
}

export function isGenericMailbox(
  account: Pick<SmartleadEmailAccount, "client_id" | "from_name" | "tags">,
  email: string,
  config: Pick<
    AppConfig,
    "extraGenericMailboxes" | "extraGenericDomains" | "prewarmedDomains"
  >,
  state: Pick<StateStore, "getPoolMailbox"> & {
    isMarkerClientId?: StateStore["isMarkerClientId"];
  },
): boolean {
  const normalized = email.trim().toLowerCase();
  if (!normalized.includes("@")) return false;
  const domain = emailDomainOf(normalized);
  // D169 / D99 / D161 — client-named BCP domains are client inventory,
  // never a generic. A leftover GENERIC tag, marker client_id, or
  // extraGenericMailbox from-name must not pull them out of A/B rest.
  if (domain && isBcpOwnedDomain(domain)) return false;
  if (isGenericPoolDomain(domain)) return true;
  // D193 — getintroduced* / quickconnect* / appquickconnect* (and the
  // other pool brands) are generic even when the exact host is new.
  if (isGenericPoolBrandDomain(domain)) return true;
  // D142 — generic-pool membership by domain, independent of pre-warmed.
  if (domain && config.extraGenericDomains.includes(domain)) return true;
  // D160 — GENERIC / POC mailbox tags are the pool label, not a client.
  if (hasPoolMarkerTag(account)) return true;
  // Drain: a leftover D142 Generic/POC client_id is still a generic
  // until the audit detaches it.
  if (
    typeof account.client_id === "number" &&
    state.isMarkerClientId?.(account.client_id)
  ) {
    return true;
  }
  if (state.getPoolMailbox(normalized)) return true;
  return isPrewarmedGeneric(account, normalized, config, state);
}
