import { loadConfig } from "../src/config.js";
import { SmartleadClient } from "../src/clients/smartlead.js";

const sl = new SmartleadClient(loadConfig(process.env).smartleadApiKey);
const campaigns = await sl.listCampaigns();
for (const campaign of campaigns) {
  const name = String(campaign.name ?? "");
  if (!/goliath/i.test(name)) continue;
  console.log(
    JSON.stringify({
      id: campaign.id,
      name,
      status: campaign.status,
      client_id: campaign.client_id,
      clientType: typeof campaign.client_id,
    }),
  );
}
