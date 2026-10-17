import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  V2_ISOLATION_PROVIDER_HYDRATE_CAP,
  V2_ISOLATION_SENDER_HYDRATE_CAP,
  V2_ISOLATION_TICK_TIMEOUT_MS,
  V2_STAFF_MEMBER_HYDRATE_CAP,
  V2_STAFF_SEQUENCE_CAP,
  V2_STAFF_TICK_TIMEOUT_MS,
} from "../canon/constants.js";
import { SmartleadReader } from "../clients/smartlead.js";
import { SmartDeliveryReader } from "../clients/smartdelivery.js";
import { loadConfig } from "../config.js";
import { applyCampaignMembers, campaignsMissingMembers } from "./inventory.js";
import { prioritizeTestsToHydrate } from "./isolation.js";
import { isPocEngagementClient, shouldStaffPocCampaign } from "./poc.js";
import { SharedSmartleadLimiter } from "./limiter.js";
import { isActiveStatus } from "./staffable.js";
import { startTick } from "./tickClock.js";
import { runStaffTick } from "../jobs/staff.js";
import { runIsolationTick } from "../jobs/isolation.js";
import { WriteGate } from "../shadow.js";
import { MemoryStore } from "../store.js";

const SMARTLEAD_KEY = process.env.SMARTLEAD_API_KEY ?? "";
const SMARTDELIVERY_KEY = process.env.SMARTDELIVERY_API_KEY ?? SMARTLEAD_KEY;

describe("D281 live read-only ticks (skipped without keys)", () => {
  it("constants fit 60/min inside the hard timeouts", () => {
    assert.equal(V2_STAFF_TICK_TIMEOUT_MS, 10 * 60 * 1000);
    assert.equal(V2_ISOLATION_TICK_TIMEOUT_MS, 8 * 60 * 1000);
    const staffRequests =
      1 + 40 + V2_STAFF_MEMBER_HYDRATE_CAP + V2_STAFF_SEQUENCE_CAP;
    const isolationRequests =
      15 + V2_ISOLATION_SENDER_HYDRATE_CAP + V2_ISOLATION_PROVIDER_HYDRATE_CAP;
    assert.ok(staffRequests * 1_000 < V2_STAFF_TICK_TIMEOUT_MS);
    assert.ok(isolationRequests * 1_000 < V2_ISOLATION_TICK_TIMEOUT_MS);
  });

  it("one staff tick against live Smartlead completes under 10 minutes", async () => {
    if (!SMARTLEAD_KEY) {
      assert.ok(true, "SMARTLEAD_API_KEY not in this env");
      return;
    }
    const tick = startTick(V2_STAFF_TICK_TIMEOUT_MS);
    const limiter = new SharedSmartleadLimiter(undefined, 1, 60, 1_000);
    const smartlead = new SmartleadReader(SMARTLEAD_KEY, (fn, signal) =>
      limiter.schedule(fn, signal),
    );
    try {
      tick.step("list_campaigns");
      const campaigns = await smartlead.listCampaigns(tick.signal);
      assert.ok(campaigns.length > 0, "live campaign list was empty");
      tick.step("list_accounts");
      let accounts = await smartlead.listAccounts({ signal: tick.signal });
      const living = campaigns.filter(
        (c) =>
          isActiveStatus(c.status) ||
          (isPocEngagementClient({ clientId: c.clientId, name: c.name }) &&
            shouldStaffPocCampaign(c)),
      );
      const missing = campaignsMissingMembers(living, accounts).slice(
        0,
        V2_STAFF_MEMBER_HYDRATE_CAP,
      );
      for (const campaign of missing) {
        tick.step("hydrate_members");
        const members = await smartlead.listCampaignAccounts(campaign.id, tick.signal);
        accounts = applyCampaignMembers(accounts, campaign.id, members);
      }
      const active = campaigns.filter((c) => isActiveStatus(c.status)).slice(0, V2_STAFF_SEQUENCE_CAP);
      for (const campaign of active) {
        tick.step("sequences");
        await smartlead.listSequences(campaign.id, tick.signal).catch(() => []);
      }
      const store = new MemoryStore();
      const config = loadConfig({ SMARTLEAD_API_KEY: SMARTLEAD_KEY } as NodeJS.ProcessEnv);
      await store.saveInventory({
        fetchedAt: new Date().toISOString(),
        campaigns,
        accounts,
      });
      tick.step("staff_tick");
      const result = await runStaffTick({
        book: { fetchedAt: new Date().toISOString(), campaigns, accounts },
        fleetEmails: [],
        gate: new WriteGate(config, store),
        store,
        config,
      });
      assert.ok(tick.elapsedMs() < V2_STAFF_TICK_TIMEOUT_MS);
      assert.ok(result.findings.length >= 0);
      console.log(
        `[v2] live staff ok elapsed_ms=${tick.elapsedMs()} campaigns=${campaigns.length} accounts=${accounts.length} findings=${result.findings.length} understaffed=${result.findings.filter((f) => f.kind === "understaffed").length}`,
      );
    } finally {
      tick.dispose();
    }
  });

  it("one isolation tick against live SmartDelivery completes under 8 minutes", async () => {
    if (!SMARTLEAD_KEY || !SMARTDELIVERY_KEY) {
      assert.ok(true, "SMARTLEAD/SMARTDELIVERY keys not in this env");
      return;
    }
    const tick = startTick(V2_ISOLATION_TICK_TIMEOUT_MS);
    const smartlead = new SmartleadReader(SMARTLEAD_KEY, (fn) => fn(), 0);
    const smartDelivery = new SmartDeliveryReader(SMARTDELIVERY_KEY);
    try {
      tick.step("list_campaigns");
      const campaigns = await smartlead.listCampaigns(tick.signal);
      tick.step("list_tests");
      const listed = await smartDelivery.listTests({ signal: tick.signal });
      const ranked = prioritizeTestsToHydrate(listed, campaigns);
      tick.step("hydrate_senders");
      const withSenders = await smartDelivery.hydrateSenders(
        ranked,
        V2_ISOLATION_SENDER_HYDRATE_CAP,
        tick.signal,
      );
      tick.step("hydrate_providers");
      const tests = await smartDelivery.hydrateProviderSplits(
        withSenders,
        V2_ISOLATION_PROVIDER_HYDRATE_CAP,
        tick.signal,
      );
      const store = new MemoryStore();
      const config = loadConfig({ SMARTDELIVERY_API_KEY: SMARTDELIVERY_KEY } as NodeJS.ProcessEnv);
      tick.step("isolation_tick");
      const result = await runIsolationTick({
        book: { fetchedAt: new Date().toISOString(), campaigns, accounts: [] },
        tests,
        fleetEmails: [],
        gate: new WriteGate(config, store),
        store,
        config,
      });
      assert.ok(tick.elapsedMs() < V2_ISOLATION_TICK_TIMEOUT_MS);
      console.log(
        `[v2] live isolation ok elapsed_ms=${tick.elapsedMs()} tests=${tests.length} scored=${result.scored} ugly=${result.findings.filter((f) => f.kind === "ugly_without_isolation").length}`,
      );
    } finally {
      tick.dispose();
    }
  });
});
