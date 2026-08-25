import { loadConfig } from "../src/config.js";
import { SmartleadClient, clientDisplayName } from "../src/clients/smartlead.js";
import { apiRequest } from "../src/lib/http.js";
import { allowsGenericStaff } from "../src/lib/clientStaffFloor.js";
import { isPodControlShellCampaign } from "../src/lib/podControlShell.js";

const BASE = "https://server.smartlead.ai/api/v1/";
const UNDER_1K = /under[-_\s]?1k\b/i;

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

const under1k = campaigns.filter((c) => UNDER_1K.test(String(c.name ?? "")));

const rows = [];
for (const campaign of goliath.filter((c) =>
  ["ACTIVE", "PAUSED", "START"].includes(String(c.status ?? "").toUpperCase()),
)) {
  let analytics: unknown = null;
  try {
    analytics = await apiRequest(BASE, key, `campaigns/${campaign.id}/analytics`);
  } catch (error) {
    analytics = { error: error instanceof Error ? error.message : String(error) };
  }
  const root = (analytics ?? {}) as Record<string, unknown>;
  const stats =
    (root.campaign_lead_stats as Record<string, unknown> | undefined) ??
    (root.campaignLeadStats as Record<string, unknown> | undefined) ??
    {};
  rows.push({
    id: campaign.id,
    name: campaign.name,
    status: campaign.status,
    sent: root.sent_count ?? root.sent ?? root.total_sent,
    bounce: root.bounce_count ?? root.bounced,
    bounceRate: root.bounce_rate ?? root.bounceRate,
    campaign_lead_stats: stats,
  });
}

console.log(
  JSON.stringify(
    {
      goliathActive: rows,
      under1k: under1k.map((c) => ({
        id: c.id,
        name: c.name,
        status: c.status,
        client_id: c.client_id,
      })),
    },
    null,
    2,
  ),
);
