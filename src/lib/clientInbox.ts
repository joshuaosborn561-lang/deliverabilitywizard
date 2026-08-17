import type { AppConfig } from "../config.js";
import type { StateStore } from "../state/store.js";

/**
 * A "client inbox" for D39 rest is a branded sender on a real client — not a
 * pre-warmed generic fleet domain and not a recovery-pool generic.
 */
export function isClientInboxEmail(
  email: string,
  opts: {
    clientId?: number | null;
    config: Pick<AppConfig, "extraGenericDomains">;
    state: Pick<StateStore, "getPoolMailbox">;
  },
): boolean {
  const normalized = email.trim().toLowerCase();
  if (!normalized.includes("@")) return false;
  if (opts.clientId == null || !Number.isFinite(opts.clientId)) return false;
  const domain = normalized.split("@")[1] ?? "";
  if (opts.config.extraGenericDomains.includes(domain)) return false;
  if (opts.state.getPoolMailbox(normalized)) return false;
  return true;
}
