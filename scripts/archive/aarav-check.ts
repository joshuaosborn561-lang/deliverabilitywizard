import { loadConfig } from "../src/config.js";
import {
  SmartleadClient,
  accountEmail,
  campaignIdsOf,
} from "../src/clients/smartlead.js";

const config = loadConfig(process.env);
const sl = new SmartleadClient(config.smartleadApiKey);
const [campaigns, accounts] = await Promise.all([
  sl.listCampaigns(),
  sl.listAllEmailAccounts({ fetchCampaigns: true }),
]);
const byId = new Map(campaigns.map((c) => [c.id, c]));
const hits = accounts.filter((a) =>
  (accountEmail(a) ?? "").includes("aaravsanchez@getoutreachdesk.info"),
);
for (const account of hits) {
  const ids = campaignIdsOf(account);
  console.log(
    JSON.stringify(
      {
        id: account.id,
        email: accountEmail(account),
        from_name: account.from_name,
        signature: account.signature,
        client_id: account.client_id,
        campaigns: ids.map((id) => {
          const c = byId.get(id);
          return {
            id,
            name: c?.name,
            status: c?.status,
            client_id: c?.client_id,
          };
        }),
      },
      null,
      2,
    ),
  );
}
