import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { loadConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartDeliveryClient } from "../clients/smartdelivery.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import { buildIsolationAction } from "../lib/isolationActions.js";
import { StateStore } from "../state/store.js";
import { CopyCanaryService } from "./copyCanary.js";

function slackStub(requested: Array<string> = []) {
  return {
    send: async () => undefined,
    notifyIsolationAction: async (details: { kind: string }) => {
      requested.push(details.kind);
    },
  } as unknown as SlackClient;
}

function shellSmartlead(extra: Record<string, unknown> = {}) {
  const createdShells: string[] = [];
  const added: Array<{ campaignId: number; ids: number[] }> = [];
  return {
    createdShells,
    added,
    api: {
      createCampaign: async (name: string) => {
        createdShells.push(name);
        return { id: 900 + createdShells.length, name, status: "PAUSED" };
      },
      getCampaignSequences: async () => [
        {
          id: 77,
          seq_number: 1,
          subject: "Quick look",
          email_body: "<div>Campaign copy</div>",
        },
      ],
      updateCampaignSequences: async () => undefined,
      updateCampaignStatus: async () => undefined,
      addLeadsToCampaign: async () => ({ added_count: 1, skipped_count: 0 }),
      getCampaignLeads: async () => ({ total_leads: 0, data: [] }),
      getCampaignEmailAccounts: async () => [],
      addEmailAccountsToCampaign: async (campaignId: number, ids: number[]) => {
        added.push({ campaignId, ids });
      },
      ...extra,
    },
  };
}

function seedFleet(state: StateStore): void {
  state.setCopyCanaryFleet({
    status: "ready",
    googleDomain: "canary-g.info",
    microsoftDomain: "canary-o.info",
    domains: ["canary-g.info", "canary-o.info"],
    emails: ["g1@canary-g.info", "o1@canary-o.info"],
    updatedAt: new Date().toISOString(),
  });
  state.upsertPoolMailbox({
    email: "g1@canary-g.info",
    domain: "canary-g.info",
    firstName: "Gale",
    lastName: "Canary",
    platform: "GOOGLE",
    status: "available",
    copyCanary: true,
    smartleadAccountId: 11,
  });
  state.upsertPoolMailbox({
    email: "o1@canary-o.info",
    domain: "canary-o.info",
    firstName: "Owen",
    lastName: "Canary",
    platform: "MICROSOFT",
    status: "available",
    copyCanary: true,
    smartleadAccountId: 12,
  });
}

import { canaryCreateLedger, planCanaryDuplicates } from "../lib/canaryDedupe.js";

const LIVE = [
  { id: 4, name: "Live A", status: "ACTIVE", client_id: 2 },
  { id: 104, name: "Canary shell: #4 Live A", status: "PAUSED" },
];

function harness(smartDelivery: Record<string, unknown>, state: StateStore) {
  const shells = shellSmartlead({
    listCampaigns: async () => LIVE,
    listAllEmailAccounts: async () => [
      { id: 11, from_email: "g1@canary-g.info", type: "GMAIL", campaign_ids: [104] },
      { id: 12, from_email: "o1@canary-o.info", type: "OUTLOOK", campaign_ids: [104] },
    ],
    removeEmailAccountsFromCampaign: async () => undefined,
    updateEmailAccount: async () => undefined,
    configureWarmup: async () => undefined,
  });
  return new CopyCanaryService(
    loadConfig({
      ENABLE_COPY_CANARY: "true",
      DRY_RUN: "false",
      AUTO_PLACEMENT_TESTS: "true",
    }),
    shells.api as unknown as SmartleadClient,
    { resolveProviderIds: async () => [2, 20], ...smartDelivery } as unknown as SmartDeliveryClient,
    slackStub(),
    state,
  );
}

async function freshState(tag: string): Promise<StateStore> {
  const state = new StateStore(`/tmp/cc-d309-${tag}-${process.pid}-${Date.now()}.json`);
  await state.load();
  seedFleet(state);
  return state;
}

const canaryTest = (id: string, extra: Record<string, unknown> = {}) => ({
  spam_test_id: id,
  test_name: "Canary copy: #4 Live A",
  status: "active",
  every_days: 1,
  ...extra,
});

describe("D309 one live canary per campaign", () => {
  beforeEach(() => canaryCreateLedger.clear());

  it("overlapping attach runs create exactly one test", async () => {
    const state = await freshState("overlap");
    let created = 0;
    const service = harness(
      {
        listTests: async () => [],
        createAutomatedPlacement: async () => {
          created += 1;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { id: `t-${created}` };
        },
      },
      state,
    );
    await Promise.all([
      service.attach({ dryRun: false }),
      service.attach({ dryRun: false }),
      service.attach({ dryRun: false }),
    ]);
    assert.equal(created, 1, "three concurrent attaches, one canary");
  });

  it("a failed (maybe-landed) create is not retried inside the cooldown", async () => {
    const state = await freshState("cooldown");
    let attempts = 0;
    const service = harness(
      {
        listTests: async () => [],
        createAutomatedPlacement: async () => {
          attempts += 1;
          throw new Error("HTTP 429");
        },
      },
      state,
    );
    const first = await service.attach({ dryRun: false });
    const second = await service.attach({ dryRun: false });
    assert.equal(attempts, 1, "second pass must not POST again");
    assert.equal(first.errors.length, 1);
    assert.equal(second.errors.length, 1);
  });

  it("a successful create is reused even while the list has not caught up", async () => {
    const state = await freshState("lag");
    let created = 0;
    const service = harness(
      {
        listTests: async () => [],
        createAutomatedPlacement: async () => {
          created += 1;
          return { id: "t-1" };
        },
      },
      state,
    );
    await service.attach({ dryRun: false });
    await service.attach({ dryRun: false });
    assert.equal(created, 1);
    assert.equal(state.getCopyCanaryTestId(4), "t-1");
  });

  it("a list at the page cap keeps the stored test instead of creating another", async () => {
    const state = await freshState("cap");
    state.setCopyCanaries(4, ["g1@canary-g.info", "o1@canary-o.info"], "stored-9");
    let created = 0;
    const filler = Array.from({ length: 5000 }, (_, i) => ({
      spam_test_id: `x${i}`,
      test_name: `Other ${i}`,
      status: "active",
      every_days: 1,
    }));
    const service = harness(
      {
        listTests: async () => filler,
        createAutomatedPlacement: async () => {
          created += 1;
          return { id: "t-new" };
        },
      },
      state,
    );
    await service.attach({ dryRun: false });
    assert.equal(created, 0);
    assert.equal(state.getCopyCanaryTestId(4), "stored-9");
  });

  it("stops (never deletes) extra living canaries and keeps the one with readings", async () => {
    const state = await freshState("dedupe");
    state.setCopyCanaries(4, ["g1@canary-g.info", "o1@canary-o.info"], "t-3");
    const stopped: string[] = [];
    const service = harness(
      {
        listTests: async () => [
          canaryTest("t-1", { created_at: "2026-10-29T05:30:00Z", current_test_run_no: 1, inbox_count: 6 }),
          canaryTest("t-2", { created_at: "2026-10-29T05:40:00Z" }),
          canaryTest("t-3", { created_at: "2026-10-29T05:50:00Z" }),
          canaryTest("t-0", { status: "stopped", created_at: "2026-10-28T01:00:00Z" }),
        ],
        stopAutomatedTest: async (id: string) => {
          stopped.push(id);
        },
        deleteTest: async () => {
          throw new Error("must never delete");
        },
        createAutomatedPlacement: async () => {
          throw new Error("must not create");
        },
      },
      state,
    );
    const result = await service.attach({ dryRun: false });
    assert.deepEqual(stopped.sort(), ["t-2", "t-3"]);
    assert.equal(state.getCopyCanaryTestId(4), "t-1", "state follows the kept test");
    assert.equal(result.errors.length, 0);
  });

  it("dry run reports duplicates and stops nothing", async () => {
    const state = await freshState("dedupe-dry");
    const stopped: string[] = [];
    const service = harness(
      {
        listTests: async () => [canaryTest("t-1"), canaryTest("t-2")],
        stopAutomatedTest: async (id: string) => {
          stopped.push(id);
        },
        createAutomatedPlacement: async () => ({ id: "x" }),
      },
      state,
    );
    await service.attach({ dryRun: true });
    assert.deepEqual(stopped, []);
  });
});

describe("planCanaryDuplicates", () => {
  it("one living test per campaign is a no-op; stopped tests are ignored", () => {
    const plan = planCanaryDuplicates([
      canaryTest("a"),
      canaryTest("b", { status: "completed" }),
      { spam_test_id: "z", test_name: "Pod control: foo", every_days: 1, status: "active" },
    ] as never);
    assert.deepEqual(plan.stop, []);
    assert.equal(plan.keep.get(4), "a");
  });

  it("prefers readings, then the stored id, then the newest", () => {
    const tests = [
      canaryTest("a", { created_at: "2026-10-29T01:00:00Z" }),
      canaryTest("b", { created_at: "2026-10-29T02:00:00Z" }),
      canaryTest("c", { created_at: "2026-10-29T03:00:00Z" }),
    ] as never;
    assert.equal(planCanaryDuplicates(tests).keep.get(4), "c");
    assert.equal(planCanaryDuplicates(tests, new Map([[4, "a"]])).keep.get(4), "a");
    const withReadings = [
      canaryTest("a", { created_at: "2026-10-29T01:00:00Z", current_test_run_no: 2 }),
      canaryTest("c", { created_at: "2026-10-29T03:00:00Z" }),
    ] as never;
    const plan = planCanaryDuplicates(withReadings, new Map([[4, "c"]]));
    assert.equal(plan.keep.get(4), "a");
    assert.deepEqual(plan.stop, [{ campaignId: 4, testId: "c" }]);
  });
});
