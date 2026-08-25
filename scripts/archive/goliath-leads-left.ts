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

const rows = [];
for (const campaign of goliath) {
  const analytics = (await apiRequest(BASE, key, `campaigns/${campaign.id}/analytics`)) as Record<
    string,
    unknown
  >;
  const stats = (analytics.campaign_lead_stats ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => {
    const x = typeof v === "number" ? v : Number(v);
    return Number.isFinite(x) ? x : 0;
  };
  rows.push({
    id: campaign.id,
    name: campaign.name,
    status: campaign.status,
    total: n(stats.total),
    notStarted: n(stats.notStarted),
    inprogress: n(stats.inprogress),
    completed: n(stats.completed),
    blocked: n(stats.blocked),
    sent: n(analytics.sent_count ?? analytics.sent),
  });
}

const live = rows.filter((r) => ["ACTIVE", "START", "PAUSED"].includes(String(r.status).toUpperCase()));
const newLeft = live.reduce((sum, r) => sum + r.notStarted, 0);
console.log(
  JSON.stringify(
    {
      newLeadsLeftOnLive: newLeft,
      live,
      stopped: rows.filter((r) => String(r.status).toUpperCase() === "STOPPED"),
    },
    null,
    2,
  ),
);
