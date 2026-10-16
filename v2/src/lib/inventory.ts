import { V2_INVENTORY_MAX_AGE_MS } from "../canon/constants.js";
import type { InventoryBook, SlimAccount, SlimCampaign } from "../types.js";

export function dedupeById<T extends { id: number }>(rows: readonly T[]): T[] {
  const map = new Map<number, T>();
  for (const row of rows) {
    const id = Number(row.id);
    if (!Number.isFinite(id)) continue;
    map.set(id, row);
  }
  return [...map.values()];
}

/** D278 — staff full inventory at most every 30 minutes. */
export function inventoryAgeMs(book: InventoryBook | null | undefined, now = Date.now()): number | null {
  if (!book?.fetchedAt) return null;
  const at = Date.parse(book.fetchedAt);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, now - at);
}

export function inventoryIsFresh(
  book: InventoryBook | null | undefined,
  now = Date.now(),
  maxAgeMs = V2_INVENTORY_MAX_AGE_MS,
): book is InventoryBook {
  const age = inventoryAgeMs(book, now);
  return age != null && age < maxAgeMs;
}

export function accountsHaveMemberships(accounts: readonly SlimAccount[]): boolean {
  return accounts.some((account) => account.campaignIds.length > 0);
}

/**
 * A cached book with living campaigns but zero campaign_ids is not
 * usable for staffing — every campaign looks 40 short and fillFloor
 * invents thousands of attaches.
 */
export function staffingInventoryReady(book: InventoryBook | null | undefined): boolean {
  if (!book) return false;
  if (book.campaigns.length < 5) return true;
  return accountsHaveMemberships(book.accounts);
}

export function campaignsMissingMembers(
  campaigns: readonly SlimCampaign[],
  accounts: readonly SlimAccount[],
): SlimCampaign[] {
  return campaigns.filter(
    (campaign) => !accounts.some((account) => account.campaignIds.includes(campaign.id)),
  );
}

export function mergeCampaignMemberships(
  accounts: readonly SlimAccount[],
  memberships: readonly { campaignId: number; accountIds: readonly number[] }[],
): SlimAccount[] {
  const byId = new Map(
    accounts.map((account) => [account.id, { ...account, campaignIds: [...account.campaignIds] }]),
  );
  for (const { campaignId, accountIds } of memberships) {
    for (const id of accountIds) {
      const row = byId.get(id);
      if (!row) continue;
      if (!row.campaignIds.includes(campaignId)) row.campaignIds.push(campaignId);
    }
  }
  return [...byId.values()];
}

export function applyCampaignMembers(
  accounts: readonly SlimAccount[],
  campaignId: number,
  members: readonly SlimAccount[],
): SlimAccount[] {
  const byId = new Map(
    accounts.map((account) => [account.id, { ...account, campaignIds: [...account.campaignIds] }]),
  );
  for (const member of members) {
    const row = byId.get(member.id) ?? { ...member, campaignIds: [...member.campaignIds] };
    if (!row.campaignIds.includes(campaignId)) row.campaignIds.push(campaignId);
    byId.set(member.id, row);
  }
  return [...byId.values()];
}

export async function loadOrRefreshInventory(
  store: { loadInventory(): Promise<InventoryBook | null> },
  fetchBook: () => Promise<InventoryBook>,
  now = Date.now(),
  maxAgeMs = V2_INVENTORY_MAX_AGE_MS,
): Promise<{ book: InventoryBook; refreshed: boolean; ageMs: number | null }> {
  const cached = await store.loadInventory();
  if (inventoryIsFresh(cached, now, maxAgeMs) && staffingInventoryReady(cached)) {
    return { book: cached, refreshed: false, ageMs: inventoryAgeMs(cached, now) };
  }
  const book = await fetchBook();
  return { book, refreshed: true, ageMs: 0 };
}
