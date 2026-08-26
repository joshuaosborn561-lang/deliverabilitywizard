/**
 * Live: set bounce auto-pause (20 under-1k/Goliath, 7 over-1k), then
 * START every PAUSED Goliath campaign. Shell / STOPPED / DRAFTED stay down.
 */
import { loadConfig } from "../src/config.js";
import {
  SmartleadClient,
  clientDisplayName,
} from "../src/clients/smartlead.js";
import { desiredBounceAutopausePercent } from "../src/lib/bounceAutopause.js";
import { allowsGenericStaff } from "../src/lib/clientStaffFloor.js";
import { isPodControlShellCampaign } from "../src/lib/podControlShell.js";
import { BounceAutopauseService } from "../src/services/bounceAutopause.js";
import { UnpauseAfterSigQaService } from "../src/services/unpauseAfterSigQa.js";

const dryRun = process.argv.includes("--dry-run");
const config = loadConfig(process.env);
const sl = new SmartleadClient(config.smartleadApiKey);

const bounce = await new BounceAutopauseService(config, sl).run({ dryRun });
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
  return (
    allowsGenericStaff(campaign, clientName, ["goliath"]) ||
    /ackley/i.test(clientName)
  );
});

console.log(
  JSON.stringify(
    {
      goliath: goliath.map((c) => ({
        id: c.id,
        name: c.name,
        status: c.status,
        want: desiredBounceAutopausePercent(String(c.name ?? "")),
      })),
    },
    null,
    2,
  ),
);

const started: Array<{ id: number; name: string; ok: boolean; error?: string }> = [];
for (const campaign of goliath) {
  const status = String(campaign.status ?? "").toUpperCase();
  if (status !== "PAUSED") continue;
  try {
    if (!dryRun) await sl.updateCampaignStatus(campaign.id, "START");
    started.push({ id: campaign.id, name: String(campaign.name ?? ""), ok: true });
    console.log(`[goliath-unpause] START #${campaign.id} ${campaign.name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    started.push({
      id: campaign.id,
      name: String(campaign.name ?? ""),
      ok: false,
      error: message,
    });
  }
}

const qa = await new UnpauseAfterSigQaService(config, sl).run({ dryRun });
console.log(JSON.stringify({ bounce, started, qa }, null, 2));
