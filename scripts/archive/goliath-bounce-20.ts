import { loadConfig } from "../src/config.js";
import { SmartleadClient, clientDisplayName } from "../src/clients/smartlead.js";
import { apiRequest } from "../src/lib/http.js";
import { allowsGenericStaff } from "../src/lib/clientStaffFloor.js";
import { isPodControlShellCampaign } from "../src/lib/podControlShell.js";

const BASE = "https://server.smartlead.ai/api/v1/";
const sl = new SmartleadClient(loadConfig(process.env).smartleadApiKey);
const key = loadConfig(process.env).smartleadApiKey;
const [campaigns, clients] = await Promise.all([sl.listCampaigns(), sl.listClients()]);
const clientsById = new Map(clients.map((c) => [c.id, c]));

const goliath = campaigns.filter((campaign) => {
  if (isPodControlShellCampaign(campaign)) return false;
  const clientName = clientDisplayName(
    typeof campaign.client_id === "number" ? clientsById.get(campaign.client_id) : undefined,
  );
  return (
    allowsGenericStaff(campaign, clientName, ["goliath"]) || /ackley/i.test(clientName)
  );
});

const results = [];
for (const campaign of goliath) {
  try {
    await apiRequest(BASE, key, `campaigns/${campaign.id}/settings`, {
      method: "POST",
      body: { bounce_autopause_threshold: "20" },
    });
    results.push({ id: campaign.id, name: campaign.name, status: campaign.status, ok: true });
    console.log(JSON.stringify({ set20: campaign.name, id: campaign.id }));
  } catch (error) {
    results.push({
      id: campaign.id,
      name: campaign.name,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

const after = await sl.listCampaigns();
console.log(
  JSON.stringify(
    {
      results,
      after: after
        .filter((c) => goliath.some((g) => g.id === c.id))
        .map((c) => ({ id: c.id, name: c.name, status: c.status })),
    },
    null,
    2,
  ),
);
