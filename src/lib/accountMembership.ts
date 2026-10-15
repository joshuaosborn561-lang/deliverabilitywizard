/**
 * D269 — Smartlead `fetch_campaigns=true` embeds a fat `campaigns[]` on
 * every mailbox. A 100-row page can be tens of MB; JSON.parse of that
 * on the main thread is the 40–50s event-loop stall at health-pass /
 * min40 start. Keep `campaign_ids` and drop the embedded objects.
 */

import type { SmartleadAccountWithCampaigns } from "../clients/smartlead.js";
import { writeFile, unlink } from "node:fs/promises";
import { parseSlimEmailAccountsFile } from "./jsonOffThread.js";
import { yieldEventLoop } from "./stringifyYielding.js";

/** Pages larger than this parse+slim off-thread so the loop can breathe. */
export const SLIM_EMAIL_ACCOUNTS_OFFTHREAD_CHARS = 256_000;
export const SLIM_ACCOUNT_YIELD_EVERY = 32;

export function slimAccountMemberships(
  account: SmartleadAccountWithCampaigns,
): SmartleadAccountWithCampaigns {
  let ids = Array.isArray(account.campaign_ids)
    ? account.campaign_ids.filter((n) => typeof n === "number" && Number.isFinite(n))
    : [];
  if (!ids.length && Array.isArray(account.campaigns)) {
    ids = account.campaigns
      .map((row) => row.id ?? row.campaign_id)
      .filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  }
  if (account.campaigns) delete account.campaigns;
  account.campaign_ids = ids;
  return account;
}

export function slimEmailAccountsPage(page: unknown): SmartleadAccountWithCampaigns[] {
  if (!Array.isArray(page)) return [];
  for (const row of page) {
    if (row && typeof row === "object") {
      slimAccountMemberships(row as SmartleadAccountWithCampaigns);
    }
  }
  return page as SmartleadAccountWithCampaigns[];
}

export async function slimInventoryAccounts(
  accounts: SmartleadAccountWithCampaigns[],
): Promise<void> {
  let n = 0;
  for (const account of accounts) {
    slimAccountMemberships(account);
    n += 1;
    if (n % SLIM_ACCOUNT_YIELD_EVERY === 0) await yieldEventLoop();
  }
}

/**
 * D270 — parse a page that is already on disk. The HTTP layer streams
 * fat fetch_campaigns bodies here so the main thread never holds the
 * raw JSON string.
 */
export async function parseSlimEmailAccountsFromFile(
  filePath: string,
): Promise<SmartleadAccountWithCampaigns[]> {
  try {
    return slimEmailAccountsPage(await parseSlimEmailAccountsFile(filePath));
  } catch {
    return [];
  }
}

/**
 * Parse one GET /email-accounts page. Fat pages go through a worker that
 * slims before postMessage so the main thread never structuredClones the
 * embedded campaign objects (D262 clone stall).
 */
export async function parseSlimEmailAccountsJson(
  text: string,
): Promise<SmartleadAccountWithCampaigns[]> {
  if (!text) return [];
  if (text.length < SLIM_EMAIL_ACCOUNTS_OFFTHREAD_CHARS) {
    try {
      return slimEmailAccountsPage(JSON.parse(text));
    } catch {
      return [];
    }
  }
  const tmp = `/tmp/sl-accounts-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`;
  await writeFile(tmp, text, "utf8");
  try {
    return await parseSlimEmailAccountsFromFile(tmp);
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}
