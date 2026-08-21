import type { AppConfig } from "../config.js";
import type { StateStore } from "../state/store.js";
import type { SmartleadEmailAccount } from "../types/index.js";
import { isPrewarmedGeneric } from "../services/warmupGate.js";

/**
 * A client inbox is a mailbox that belongs to a Smartlead client and is not
 * a pool generic or a pre-warmed fleet sender (D41). Those rest on the
 * 2-on/2-off cadence; generics are the spare tire and stay available.
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
