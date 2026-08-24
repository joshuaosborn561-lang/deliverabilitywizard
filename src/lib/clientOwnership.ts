import type { AppConfig } from "../config.js";
import type { StateStore } from "../state/store.js";
import type { SmartleadEmailAccount } from "../types/index.js";
import { isGenericMailbox } from "./clientInbox.js";
import { isCopyCanaryFleetDomain } from "./copyCanaryFleet.js";
import { normalizeIsolationDomain } from "./isolationDomain.js";

/** Sending domain for an email, lowercased. */
export function sendingDomainOf(email: string): string {
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  return at >= 0 ? normalized.slice(at + 1) : "";
}

export function genericStillOnLiveCampaigns(
  campaignIds: number[],
  campaignById: Map<number, { status?: string | null }>,
): boolean {
  return campaignIds.some((id) => {
    const campaign = campaignById.get(id);
    return String(campaign?.status ?? "").toUpperCase() === "ACTIVE";
  });
}

/**
 * D66 — a generic that is not sending for a client carries no client_id.
 */
export function genericClientIdWhenIdle(): null {
  return null;
}

export function genericIdentityClearFields(
  firstName: string,
  lastName: string,
): { signature: string; from_name: string; client_id: null } {
  const name = `${firstName.trim()} ${lastName.trim()}`.trim() || "Generic";
  return {
    signature: name,
    from_name: name,
    client_id: genericClientIdWhenIdle(),
  };
}

export function isUntiedInfrastructureDomain(
  domain: string,
  extraGenericDomains: string[],
  opts: {
    copyCanaryDomains?: string[];
    isolationDomain?: string;
    extraUntiedDomains?: string[];
  } = {},
): boolean {
  const d = domain.trim().toLowerCase();
  if (!d) return false;
  if (extraGenericDomains.some((row) => row.toLowerCase() === d)) return true;
  if (opts.extraUntiedDomains?.some((row) => row.toLowerCase() === d)) return true;
  if (opts.copyCanaryDomains?.some((row) => row.toLowerCase() === d)) return true;
  if (isCopyCanaryFleetDomain(d, { domains: opts.copyCanaryDomains ?? [], emails: [], status: "ready", updatedAt: "" })) {
    return true;
  }
  const isolation = normalizeIsolationDomain(opts.isolationDomain);
  return Boolean(isolation && d === isolation);
}

export function isGenericForOwnership(
  account: Pick<SmartleadEmailAccount, "client_id" | "from_name">,
  email: string,
  config: Pick<AppConfig, "extraGenericMailboxes" | "extraGenericDomains">,
  state: Pick<StateStore, "getPoolMailbox">,
  opts: {
    copyCanaryDomains?: string[];
    isolationDomain?: string;
    extraUntiedDomains?: string[];
  } = {},
): boolean {
  if (isGenericMailbox(account, email, config, state)) return true;
  return isUntiedInfrastructureDomain(sendingDomainOf(email), config.extraGenericDomains, opts);
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Floor inventory ignores inboxes still owing the warmup clock (D66 / D50). */
export function isWarmedForClientFloor(
  createdAt: string | undefined,
  minDays: number,
  now: Date,
): boolean {
  if (!minDays || minDays <= 0) return true;
  if (!createdAt) return true;
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return true;
  return (now.getTime() - created) / MS_PER_DAY >= minDays;
}
