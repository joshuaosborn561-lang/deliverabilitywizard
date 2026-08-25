import { loadConfig } from "../src/config.js";
import { SmartleadClient, accountEmail, campaignIdsOf } from "../src/clients/smartlead.js";

const LIVE = 3730560;
const CLIENT = 521881;

const sl = new SmartleadClient(loadConfig(process.env).smartleadApiKey);
const accounts = await sl.listAllEmailAccounts({ fetchCampaigns: true });
const onLive = accounts.filter(
  (a) => a.client_id === CLIENT && campaignIdsOf(a).includes(LIVE),
);
console.log(
  JSON.stringify(
    {
      onLiveCount: onLive.length,
      emails: onLive.map((a) => accountEmail(a)).sort(),
    },
    null,
    2,
  ),
);
