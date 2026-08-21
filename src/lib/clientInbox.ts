import type { AppConfig } from "../config.js";
import type { StateStore } from "../state/store.js";
import type { SmartleadEmailAccount } from "../types/index.js";
import { isPrewarmedGeneric } from "../services/warmupGate.js";

/**
 * A client inbox belongs to a Smartlead client and is not a pool generic
 * or a pre-warmed fleet sender. Only these take the per-client A/B rest
 * (D43). Generics fill to 50 and rest on a 2-week send clock.
 */
export function isClientInbox(
  account: Pick<SmartleadEmailAccount, "client_id" | "from_name">,
  email: string,
  config: Pick<AppConfig, "extraGenericMailboxes" | "extraGenericDomains">,
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
  config: Pick<AppConfig, "extraGenericMailboxes" | "extraGenericDomains">,
  state: Pick<StateStore, "getPoolMailbox">,
): boolean {
  return isClientInbox(account, email, config, state);
}

export function isGenericMailbox(
  account: Pick<SmartleadEmailAccount, "client_id" | "from_name">,
  email: string,
  config: Pick<AppConfig, "extraGenericMailboxes" | "extraGenericDomains">,
  state: Pick<StateStore, "getPoolMailbox">,
): boolean {
  const normalized = email.trim().toLowerCase();
  if (!normalized.includes("@")) return false;
  if (state.getPoolMailbox(normalized)) return true;
  return isPrewarmedGeneric(account, normalized, config, state);
}
