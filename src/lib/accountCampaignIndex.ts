import {
  accountEmail,
  campaignIdsOf,
  type SmartleadAccountWithCampaigns,
} from "../clients/smartlead.js";
import { runWithStallScopeAsync } from "./eventLoopAttribution.js";
import { yieldEventLoop } from "./stringifyYielding.js";

export const INDEX_ACCOUNTS_YIELD_EVERY = 32;

/** One pass so later walks do not rescan every mailbox for every campaign. */
export async function indexAccountsByCampaign(
  accounts: SmartleadAccountWithCampaigns[],
): Promise<Map<number, SmartleadAccountWithCampaigns[]>> {
  return runWithStallScopeAsync("scan:indexAccountsByCampaign", async () => {
    const byCampaign = new Map<number, SmartleadAccountWithCampaigns[]>();
    let n = 0;
    for (const account of accounts) {
      for (const id of campaignIdsOf(account)) {
        const list = byCampaign.get(id);
        if (list) list.push(account);
        else byCampaign.set(id, [account]);
      }
      n += 1;
      if (n % INDEX_ACCOUNTS_YIELD_EVERY === 0) await yieldEventLoop();
    }
    return byCampaign;
  });
}

export async function indexAccountsByEmail(
  accounts: SmartleadAccountWithCampaigns[],
): Promise<Map<string, SmartleadAccountWithCampaigns>> {
  return runWithStallScopeAsync("scan:indexAccountsByEmail", async () => {
    const byEmail = new Map<string, SmartleadAccountWithCampaigns>();
    let n = 0;
    for (const account of accounts) {
      const email = accountEmail(account)?.toLowerCase();
      if (email) byEmail.set(email, account);
      n += 1;
      if (n % INDEX_ACCOUNTS_YIELD_EVERY === 0) await yieldEventLoop();
    }
    return byEmail;
  });
}
