import {
  accountEmail,
  resolveAccountClient,
  type SmartleadAccountWithCampaigns,
  type SmartleadClientRecord,
} from "../clients/smartlead.js";
import type { AppConfig } from "../config.js";
import type { StateStore } from "../state/store.js";
import type { SmartleadCampaign } from "../types/index.js";
import { isClientInbox } from "./clientInbox.js";

/**
 * D58 — live staffable floor is half that client's own inboxes.
 * Odd counts round down (Goliath 25 → 12). After D61/D62, Vasco 40 → 20.
 */
export function clientInboxStaffFloor(clientInboxCount: number): number {
  if (!Number.isFinite(clientInboxCount) || clientInboxCount <= 0) return 0;
  return Math.floor(clientInboxCount / 2);
}

export function clientCountKey(clientId: number | null | undefined): string {
  return typeof clientId === "number" && Number.isFinite(clientId)
    ? `id:${clientId}`
    : "unassigned";
}

export function allowsGenericStaff(
  campaign: { name?: string | null; client_id?: number | null },
  clientName: string | null | undefined,
  patterns: string[],
): boolean {
  const hay = `${campaign.name ?? ""} ${clientName ?? ""}`.toLowerCase();
  return patterns.some((pattern) => {
    const p = pattern.trim().toLowerCase();
    return Boolean(p) && hay.includes(p);
  });
}

export function countClientInboxesByKey(
  accounts: SmartleadAccountWithCampaigns[],
  campaigns: SmartleadCampaign[],
  clients: SmartleadClientRecord[],
  config: Pick<AppConfig, "extraGenericMailboxes" | "extraGenericDomains">,
  state: Pick<StateStore, "getPoolMailbox">,
): Map<string, number> {
  const campaignClientById = new Map(
    campaigns.map((campaign) => [campaign.id, campaign.client_id]),
  );
  const clientsById = new Map(clients.map((client) => [client.id, client]));
  const counts = new Map<string, number>();
  for (const account of accounts) {
    const email = accountEmail(account);
    if (!email) continue;
    if (!isClientInbox(account, email, config, state)) continue;
    const resolved = resolveAccountClient(account, campaignClientById, clientsById);
    const key = clientCountKey(resolved.clientId);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function staffFloorForCampaign(
  campaign: { name?: string | null; client_id?: number | null },
  clientInboxCounts: Map<string, number>,
  clientName?: string | null,
  fullSendPatterns: string[] = [],
): number {
  const count =
    clientInboxCounts.get(clientCountKey(campaign.client_id)) ?? 0;
  if (fullSendPatterns.length && allowsGenericStaff(campaign, clientName, fullSendPatterns)) {
    return count;
  }
  return clientInboxStaffFloor(count);
}
