import {
  accountEmail,
  campaignIdsOf,
  type SmartleadAccountWithCampaigns,
} from "../clients/smartlead.js";

/** One pass so later walks do not rescan every mailbox for every campaign. */
export function indexAccountsByCampaign(
  accounts: SmartleadAccountWithCampaigns[],
): Map<number, SmartleadAccountWithCampaigns[]> {
  const byCampaign = new Map<number, SmartleadAccountWithCampaigns[]>();
  for (const account of accounts) {
    for (const id of campaignIdsOf(account)) {
      const list = byCampaign.get(id);
      if (list) list.push(account);
      else byCampaign.set(id, [account]);
    }
  }
  return byCampaign;
}

export function indexAccountsByEmail(
  accounts: SmartleadAccountWithCampaigns[],
): Map<string, SmartleadAccountWithCampaigns> {
  const byEmail = new Map<string, SmartleadAccountWithCampaigns>();
  for (const account of accounts) {
    const email = accountEmail(account)?.toLowerCase();
    if (email) byEmail.set(email, account);
  }
  return byEmail;
}
