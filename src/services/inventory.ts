import type {
  SmartleadAccountWithCampaigns,
  SmartleadClient,
  SmartleadClientRecord,
} from "../clients/smartlead.js";
import type { SmartleadCampaign } from "../types/index.js";

/**
 * D84 — one Smartlead inventory fetch per health pass.
 *
 * Before this, every stage of the 15-minute loop (rest, client tag,
 * one-client, campaign check, fan-out, top-up, mailbox gap) refetched
 * campaigns + ~12 paginated account pages + clients on its own. Eight
 * refetches per pass plus the 10-minute bounce loop exhausted Smartlead's
 * rate limit, stages died on 429 with a swallowed console.warn, and the
 * "15-minute" cadence quietly became fiction. One snapshot per pass is the
 * fix, not a cache for its own sake.
 *
 * Mutating stages keep the snapshot honest with recordMembership /
 * dropMembership instead of refetching mid-pass.
 */
export interface InventorySnapshot {
  campaigns: SmartleadCampaign[];
  accounts: SmartleadAccountWithCampaigns[];
  clients: SmartleadClientRecord[];
  fetchedAt: number;
}

export async function fetchInventory(
  smartlead: Pick<SmartleadClient, "listCampaigns" | "listAllEmailAccounts"> &
    Partial<Pick<SmartleadClient, "listClients">>,
): Promise<InventorySnapshot> {
  const [campaigns, accounts, clients] = await Promise.all([
    smartlead.listCampaigns(),
    smartlead.listAllEmailAccounts({ fetchCampaigns: true }),
    typeof smartlead.listClients === "function"
      ? smartlead.listClients().catch(() => [] as SmartleadClientRecord[])
      : Promise.resolve([] as SmartleadClientRecord[]),
  ]);
  return {
    campaigns: campaigns as SmartleadCampaign[],
    accounts: accounts as SmartleadAccountWithCampaigns[],
    clients,
    fetchedAt: Date.now(),
  };
}

/** Keep the in-pass snapshot truthful after a successful campaign add. */
export function recordMembership(
  account: SmartleadAccountWithCampaigns,
  campaignId: number,
): void {
  const ids = Array.isArray(account.campaign_ids) ? account.campaign_ids : [];
  if (!ids.includes(campaignId)) {
    account.campaign_ids = [...ids, campaignId];
  }
}

/** Keep the in-pass snapshot truthful after a successful campaign remove. */
export function dropMembership(
  account: SmartleadAccountWithCampaigns,
  campaignId: number,
): void {
  if (Array.isArray(account.campaign_ids)) {
    account.campaign_ids = account.campaign_ids.filter((id) => id !== campaignId);
  }
  if (Array.isArray(account.campaigns)) {
    account.campaigns = account.campaigns.filter(
      (row) => (row.id ?? row.campaign_id) !== campaignId,
    );
  }
}
