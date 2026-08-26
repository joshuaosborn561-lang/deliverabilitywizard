/**
 * D124 — one-shot: turn Smartlead bounce autopause off (100) on every
 * living campaign. GET /settings 404s on this account, so this is POST
 * only. Does not START anyone. Does not touch shells or COMPLETED/STOPPED.
 *
 * FORCE_IDS=1,2,3 limits the write to those campaign ids (retry 429s).
 *
 * Usage: railway run --service deliverabilitywizard --environment production -- npx tsx scripts/force-autopause-off.ts
 */
import { loadConfig } from "../src/config.js";
import { SmartleadClient } from "../src/clients/smartlead.js";
import { campaignSettingsWriteBody } from "../src/lib/bounceAutopause.js";
import { SMARTLEAD_BOUNCE_AUTOPAUSE_OFF_PERCENT } from "../src/lib/campaignBounceAutostop.js";
import { isAnyShellCampaign } from "../src/lib/canaryShell.js";
import { isTerminalCampaignStatus } from "../src/services/campaignBounceAutostop.js";
import { sleep } from "../src/lib/http.js";

const WRITE_GAP_MS = 500;
const off = String(SMARTLEAD_BOUNCE_AUTOPAUSE_OFF_PERCENT);
const onlyIds = new Set(
  (process.env.FORCE_IDS ?? "")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((id) => Number.isFinite(id) && id > 0),
);

const config = loadConfig(process.env);
if (!config.smartleadApiKey) {
  console.error("[force-autopause-off] SMARTLEAD_API_KEY is not set");
  process.exit(1);
}

const smartlead = new SmartleadClient(config.smartleadApiKey);
const campaigns = await smartlead.listCampaigns();
const living = campaigns.filter((campaign) => {
  if (isAnyShellCampaign(campaign, config.podControlShellCampaignId)) {
    return false;
  }
  if (isTerminalCampaignStatus(campaign.status)) return false;
  if (onlyIds.size > 0 && !onlyIds.has(campaign.id)) return false;
  return true;
});

console.log(
  `[force-autopause-off] listed=${campaigns.length} living=${living.length} off=${off}${onlyIds.size ? ` ids=${[...onlyIds].join(",")}` : ""}`,
);

let written = 0;
let errors = 0;
for (const campaign of living) {
  const label = `#${campaign.id} ${campaign.name} ${campaign.status}`;
  try {
    await smartlead.updateCampaignSettings(
      campaign.id,
      campaignSettingsWriteBody(
        {},
        { bounce_autopause_threshold: off },
      ),
    );
    await sleep(WRITE_GAP_MS);
    written += 1;
    console.log(
      JSON.stringify({
        id: campaign.id,
        name: campaign.name,
        status: campaign.status,
        ok: true,
      }),
    );
  } catch (error) {
    errors += 1;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[force-autopause-off] ${label}: ${message}`);
  }
}

console.log(`[force-autopause-off] written=${written} errors=${errors}`);
if (errors > 0) process.exit(1);
