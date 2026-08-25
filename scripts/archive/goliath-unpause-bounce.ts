/**
 * Josh (2026-08-25): unpause all Goliath; apply D67 bounce auto-pause.
 * Under-1k → 20%. Goliath band / Over-1k stay at 7%.
 * STARTs PAUSED Goliath only. Does not start DRAFTED / STOPPED / the shell.
 */
import { loadConfig } from "../src/config.js";
import {
  SmartleadClient,
  clientDisplayName,
} from "../src/clients/smartlead.js";
import { apiRequest } from "../src/lib/http.js";
import { isPodControlShellCampaign } from "../src/lib/podControlShell.js";
import { allowsGenericStaff } from "../src/lib/clientStaffFloor.js";

const BASE = "https://server.smartlead.ai/api/v1/";
const UNDER_1K = /under[-_\s]?1k\b/i;

function isUnder1k(name: string): boolean {
  return UNDER_1K.test(name);
}

function desiredThreshold(name: string): number {
  return isUnder1k(name) ? 20 : 7;
}

async function main() {
  const config = loadConfig(process.env);
  const sl = new SmartleadClient(config.smartleadApiKey);
  const [campaigns, clients] = await Promise.all([
    sl.listCampaigns(),
    sl.listClients(),
  ]);
  const clientsById = new Map(clients.map((c) => [c.id, c]));

  const goliath = campaigns.filter((campaign) => {
    if (isPodControlShellCampaign(campaign)) return false;
    const clientName = clientDisplayName(
      typeof campaign.client_id === "number"
        ? clientsById.get(campaign.client_id)
        : undefined,
    );
    if (allowsGenericStaff(campaign, clientName, ["goliath"])) return true;
    return /ackley/i.test(clientName);
  });

  console.log(
    JSON.stringify(
      {
        goliathCount: goliath.length,
        byStatus: goliath.reduce<Record<string, number>>((acc, c) => {
          const s = String(c.status ?? "UNKNOWN").toUpperCase();
          acc[s] = (acc[s] ?? 0) + 1;
          return acc;
        }, {}),
        campaigns: goliath.map((c) => ({
          id: c.id,
          name: c.name,
          status: c.status,
          client_id: c.client_id,
          client: clientDisplayName(
            typeof c.client_id === "number" ? clientsById.get(c.client_id) : undefined,
          ),
          under1k: isUnder1k(String(c.name ?? "")),
          bounceAutopause: desiredThreshold(String(c.name ?? "")),
        })),
      },
      null,
      2,
    ),
  );

  const settingsResults: Array<{ id: number; name: string; threshold: number; ok: boolean; error?: string }> =
    [];
  for (const campaign of goliath) {
    const threshold = desiredThreshold(String(campaign.name ?? ""));
    try {
      await apiRequest(BASE, config.smartleadApiKey, `campaigns/${campaign.id}/settings`, {
        method: "POST",
        body: { bounce_autopause_threshold: String(threshold) },
      });
      settingsResults.push({
        id: campaign.id,
        name: String(campaign.name ?? ""),
        threshold,
        ok: true,
      });
      console.log(
        JSON.stringify({ settings: campaign.name, id: campaign.id, threshold }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      settingsResults.push({
        id: campaign.id,
        name: String(campaign.name ?? ""),
        threshold,
        ok: false,
        error: message,
      });
      console.error(JSON.stringify({ settingsFailed: campaign.name, id: campaign.id, error: message }));
    }
  }

  const started: Array<{ id: number; name: string; from: string; ok: boolean; error?: string }> =
    [];
  for (const campaign of goliath) {
    const status = String(campaign.status ?? "").toUpperCase();
    if (status !== "PAUSED") continue;
    try {
      await sl.updateCampaignStatus(campaign.id, "START");
      started.push({
        id: campaign.id,
        name: String(campaign.name ?? ""),
        from: status,
        ok: true,
      });
      console.log(JSON.stringify({ started: campaign.name, id: campaign.id }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      started.push({
        id: campaign.id,
        name: String(campaign.name ?? ""),
        from: status,
        ok: false,
        error: message,
      });
      console.error(JSON.stringify({ startFailed: campaign.name, id: campaign.id, error: message }));
    }
  }

  const after = await sl.listCampaigns();
  const afterGoliath = after.filter((campaign) => goliath.some((g) => g.id === campaign.id));
  console.log(
    JSON.stringify(
      {
        done: true,
        settingsOk: settingsResults.filter((r) => r.ok).length,
        settingsFailed: settingsResults.filter((r) => !r.ok),
        startedOk: started.filter((r) => r.ok).length,
        startedFailed: started.filter((r) => !r.ok),
        afterByStatus: afterGoliath.reduce<Record<string, number>>((acc, c) => {
          const s = String(c.status ?? "UNKNOWN").toUpperCase();
          acc[s] = (acc[s] ?? 0) + 1;
          return acc;
        }, {}),
        after: afterGoliath.map((c) => ({
          id: c.id,
          name: c.name,
          status: c.status,
        })),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
