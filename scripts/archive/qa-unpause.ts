/**
 * Assign missing campaign client tags, then START paused Goliath
 * campaigns whose senders match that client.
 */
import { loadConfig } from "../src/config.js";
import { SmartleadClient } from "../src/clients/smartlead.js";
import { CampaignClientTagService } from "../src/services/campaignClientTag.js";
import { UnpauseAfterSigQaService } from "../src/services/unpauseAfterSigQa.js";

const dryRun = process.argv.includes("--dry-run");
const config = loadConfig(process.env);
const sl = new SmartleadClient(config.smartleadApiKey);
const tags = await new CampaignClientTagService(config, sl).run({ dryRun });
const unpause = await new UnpauseAfterSigQaService(config, sl).run({ dryRun });
console.log(JSON.stringify({ tags, unpause }, null, 2));
