import type { AppConfig } from "../config.js";
import type { StateStore } from "../state/store.js";
import type { SmartleadEmailAccount } from "../types/index.js";
import { isPrewarmedGeneric } from "../services/warmupGate.js";

/**
 * A client inbox is a mailbox that belongs to a Smartlead client and is not
 * a pool generic or a pre-warmed fleet sender. Client vs generic still matters
 * for canary slice and day-brief piles; both rest on the 2/2 cadence (D41/D42).
 */
export function isClientInbox(
  account: Pick<SmartleadEmailAccount, "client_id" | "from_name">,
  email: string,
  config: Pick<AppConfig, "extraGenericMailboxes" | "extraGenericDomains">,
  state: Pick<StateStore, "getPoolMailbox">,
): boolean {
  const normalized = email.trim().toLowerCase();
  if (!normalized.includes("@")) return false;
  if (typeof account.client_id !== "number" || !Number.isFinite(account.client_id)) {
    return false;
  }
  if (state.getPoolMailbox(normalized)) return false;
  if (isPrewarmedGeneric(account, normalized, config, state)) return false;
  return true;
}

/**
 * True for mailboxes that owe 2 weeks on / 2 weeks off (D41 + D42):
 * client inboxes, pool generics, and pre-warmed fleet senders.
 */
export function isRestEligibleMailbox(
  account: Pick<SmartleadEmailAccount, "client_id" | "from_name">,
  email: string,
  config: Pick<AppConfig, "extraGenericMailboxes" | "extraGenericDomains">,
  state: Pick<StateStore, "getPoolMailbox">,
): boolean {
  const normalized = email.trim().toLowerCase();
  if (!normalized.includes("@")) return false;
  if (isClientInbox(account, email, config, state)) return true;
  if (state.getPoolMailbox(normalized)) return true;
  if (isPrewarmedGeneric(account, normalized, config, state)) return true;
  return false;
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
