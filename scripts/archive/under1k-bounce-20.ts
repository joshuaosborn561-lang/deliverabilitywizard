import { loadConfig } from "../src/config.js";
import { SmartleadClient } from "../src/clients/smartlead.js";
import { apiRequest } from "../src/lib/http.js";

const BASE = "https://server.smartlead.ai/api/v1/";
const UNDER_1K = /under[-_\s]?1k\b/i;
const sl = new SmartleadClient(loadConfig(process.env).smartleadApiKey);
const key = loadConfig(process.env).smartleadApiKey;
const campaigns = await sl.listCampaigns();
const under1k = campaigns.filter((c) => UNDER_1K.test(String(c.name ?? "")));
for (const campaign of under1k) {
  await apiRequest(BASE, key, `campaigns/${campaign.id}/settings`, {
    method: "POST",
    body: { bounce_autopause_threshold: "20" },
  });
  console.log(JSON.stringify({ set20: campaign.name, id: campaign.id, status: campaign.status }));
}
