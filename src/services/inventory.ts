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

export const INVENTORY_429_ATTEMPTS = 3;
export const INVENTORY_429_DELAY_MS = 30_000;

export function isSmartleadRateLimit(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b429\b|rate limit/i.test(message);
}

export async function fetchInventory(
  smartlead: Pick<SmartleadClient, "listCampaigns" | "listAllEmailAccounts"> &
    Partial<Pick<SmartleadClient, "listClients">>,
  opts?: {
    retryDelayMs?: number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<InventorySnapshot> {
  const attempts = INVENTORY_429_ATTEMPTS;
  const delayMs = opts?.retryDelayMs ?? INVENTORY_429_DELAY_MS;
  const sleep =
    opts?.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
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
    } catch (error) {
      lastError = error;
      if (!isSmartleadRateLimit(error) || attempt === attempts) {
        throw error;
      }
      console.warn(
        `[inventory] ${error instanceof Error ? error.message : String(error)} — retry ${attempt}/${attempts - 1} in ${delayMs}ms`,
      );
      await sleep(delayMs);
    }
  }
  throw lastError;
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
