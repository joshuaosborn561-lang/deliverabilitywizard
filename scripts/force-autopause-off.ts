/**
 * D124 — one-shot: turn Smartlead bounce autopause off (100) on every
 * living campaign. GET-echoes settings so the UI toggle updates.
 * Does not START anyone. Does not touch shells or COMPLETED/STOPPED.
 *
 * Usage: railway run --service deliverabilitywizard --environment production -- npx tsx scripts/force-autopause-off.ts
 */
import { loadConfig } from "../src/config.js";
import { SmartleadClient } from "../src/clients/smartlead.js";
import {
  campaignSettingsWriteBody,
  readBounceAutopausePercent,
} from "../src/lib/bounceAutopause.js";
import { SMARTLEAD_BOUNCE_AUTOPAUSE_OFF_PERCENT } from "../src/lib/campaignBounceAutostop.js";
import { isAnyShellCampaign } from "../src/lib/canaryShell.js";
import { isTerminalCampaignStatus } from "../src/services/campaignBounceAutostop.js";
import { sleep } from "../src/lib/http.js";

const WRITE_GAP_MS = 350;
const off = String(SMARTLEAD_BOUNCE_AUTOPAUSE_OFF_PERCENT);

const config = loadConfig(process.env);
if (!config.smartleadApiKey) {
  console.error("[force-autopause-off] SMARTLEAD_API_KEY is not set");
  process.exit(1);
}

const smartlead = new SmartleadClient(config.smartleadApiKey);
const campaigns = await smartlead.listCampaigns();
const living = campaigns.filter(
  (campaign) =>
    !isAnyShellCampaign(campaign, config.podControlShellCampaignId) &&
    !isTerminalCampaignStatus(campaign.status),
);

console.log(
  `[force-autopause-off] listed=${campaigns.length} living=${living.length} off=${off}`,
);

let written = 0;
let already = 0;
let errors = 0;
for (const campaign of living) {
  const label = `#${campaign.id} ${campaign.name} ${campaign.status}`;
  try {
    const beforeSettings = await smartlead.getCampaignSettings(campaign.id);
    await sleep(120);
    const before = readBounceAutopausePercent(beforeSettings);
    const body = campaignSettingsWriteBody(beforeSettings ?? {}, {
      bounce_autopause_threshold: off,
    });
    await smartlead.updateCampaignSettings(campaign.id, body);
    await sleep(WRITE_GAP_MS);
    const afterSettings = await smartlead.getCampaignSettings(campaign.id);
    await sleep(120);
    const after = readBounceAutopausePercent(afterSettings);
    if (after === Number(off)) {
      if (before === Number(off)) already += 1;
      written += 1;
    } else {
      errors += 1;
    }
    console.log(
      JSON.stringify({
        id: campaign.id,
        name: campaign.name,
        status: campaign.status,
        before,
        after,
        ok: after === Number(off),
      }),
    );
  } catch (error) {
    errors += 1;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[force-autopause-off] ${label}: ${message}`);
  }
}

console.log(
  `[force-autopause-off] written=${written} alreadyOff=${already} errors=${errors}`,
);
if (errors > 0) process.exit(1);
