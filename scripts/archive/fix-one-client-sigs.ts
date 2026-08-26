/**
 * Live: pull cross-client campaign memberships, restore generics onto
 * Goliath, and rewrite foreign signatures. Pass --dry-run to plan only.
 */
import { loadConfig } from "../src/config.js";
import { SmartleadClient } from "../src/clients/smartlead.js";
import { StateStore } from "../src/state/store.js";
import { OneClientMembershipService } from "../src/services/oneClientMembership.js";

const dryRun = process.argv.includes("--dry-run");
const config = loadConfig(process.env);
const sl = new SmartleadClient(config.smartleadApiKey);
const state = new StateStore(config.stateFilePath);
await state.load();
const result = await new OneClientMembershipService(config, sl, state).run({
  dryRun,
});
console.log(JSON.stringify(result, null, 2));
