import type { AppConfig } from "../config.js";
import { GENERIC_POOL_PLAN } from "../data/genericPoolPlan.js";
import type { StateStore } from "../state/store.js";
import type { SmartleadEmailAccount } from "../types/index.js";
import { emailDomainOf } from "./isolationDomain.js";
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

/** True when the sending domain is in the InboxKit generic-pool plan. */
export function isGenericPoolDomain(domain: string | undefined): boolean {
  if (!domain) return false;
  return POOL_PLAN_DOMAINS.has(domain.trim().toLowerCase());
}

/**
 * A client inbox belongs to a Smartlead client and is not a pool generic
 * or a pre-warmed fleet sender. Only these take the per-client A/B rest
 * (D43). Generics fill to 50 and rest on a 2-week send clock.
 */
export function isClientInbox(
  account: Pick<SmartleadEmailAccount, "client_id" | "from_name">,
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
  account: Pick<SmartleadEmailAccount, "client_id" | "from_name">,
  email: string,
  config: Pick<AppConfig, "extraGenericMailboxes" | "extraGenericDomains" | "prewarmedDomains">,
  state: Pick<StateStore, "getPoolMailbox">,
): boolean {
  return isClientInbox(account, email, config, state);
}

export function isGenericMailbox(
  account: Pick<SmartleadEmailAccount, "client_id" | "from_name">,
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
  if (isGenericPoolDomain(domain)) return true;
  // D142 — generic-pool membership by domain, independent of pre-warmed.
  if (domain && config.extraGenericDomains.includes(domain)) return true;
  // D142 — a box assigned to the Generic/POC marker client is a generic.
  if (
    typeof account.client_id === "number" &&
    state.isMarkerClientId?.(account.client_id)
  ) {
    return true;
  }
  if (state.getPoolMailbox(normalized)) return true;
  return isPrewarmedGeneric(account, normalized, config, state);
}
