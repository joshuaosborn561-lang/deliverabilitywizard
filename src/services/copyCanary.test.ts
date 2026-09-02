import assert from "node:assert/strict";
import { describe, it } from "node:test";
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

describe("CopyCanaryService", () => {
  it("schedules campaign-copy tests on paused shells, never live campaigns", async () => {
    const state = new StateStore(
      `/tmp/copy-canary-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    seedFleet(state);

    const removed: Array<{ campaignId: number; ids: number[] }> = [];
    const created: Array<{
      name?: string;
      senders: string[];
      campaignId?: number;
      sequenceMappingId?: number;
      sequence?: unknown;
    }> = [];
    const shells = shellSmartlead({
      listCampaigns: async () => [
        { id: 4, name: "Live A", status: "ACTIVE", client_id: 2 },
        { id: 5, name: "Live B", status: "ACTIVE", client_id: 9 },
        { id: 104, name: "Canary shell: #4 Live A", status: "PAUSED" },
        { id: 105, name: "Canary shell: #5 Live B", status: "PAUSED" },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 11,
          from_email: "g1@canary-g.info",
          type: "GMAIL",
          campaign_ids: [4, 104],
        },
        {
          id: 12,
          from_email: "o1@canary-o.info",
          type: "OUTLOOK",
          campaign_ids: [104],
        },
      ],
      removeEmailAccountsFromCampaign: async (
        campaignId: number,
        ids: number[],
      ) => {
        removed.push({ campaignId, ids });
      },
      updateEmailAccount: async () => undefined,
      configureWarmup: async () => undefined,
    });
    const smartlead = shells.api as unknown as SmartleadClient;
    const smartDelivery = {
      listTests: async () => [],
      resolveProviderIds: async () => [2, 20],
      createAutomatedPlacement: async (payload: {
        test_name?: string;
        sender_accounts: string[];
        campaign_id?: number;
        sequence_mapping_id?: number;
        sequence?: unknown;
      }) => {
        created.push({
          name: payload.test_name,
          senders: payload.sender_accounts,
          campaignId: payload.campaign_id,
          sequenceMappingId: payload.sequence_mapping_id,
          sequence: payload.sequence,
        });
        return { id: `t-${created.length}` };
      },
      createManualPlacement: async () => {
        throw new Error("should use recurring tests");
      },
    } as unknown as SmartDeliveryClient;

    const service = new CopyCanaryService(
      loadConfig({
        ENABLE_COPY_CANARY: "true",
        DRY_RUN: "false",
        AUTO_PLACEMENT_TESTS: "true",
      }),
      smartlead,
      smartDelivery,
      slackStub(),
      state,
    );

    const result = await service.attach({ dryRun: false });
    assert.deepEqual(
      shells.added.map((row) => row.campaignId).sort((a, b) => a - b),
      [104, 105],
    );
    assert.ok(
      shells.added.every((row) => row.campaignId !== 4 && row.campaignId !== 5),
      "canaries must not be added to live campaigns (D55/D114)",
    );
    assert.deepEqual(removed, [{ campaignId: 4, ids: [11] }]);
    assert.equal(created.length, 2);
    assert.ok(created.every((row) => row.name?.startsWith("Canary copy:")));
    assert.deepEqual(
      created.map((row) => row.campaignId).sort((a, b) => (a ?? 0) - (b ?? 0)),
      [104, 105],
    );
    assert.ok(
      created.every((row) => row.sequenceMappingId === 77),
      "canary schedule sends the shell sequence_mapping_id (D114)",
    );
    assert.ok(
      created.every((row) => row.sequence == null),
      "canary schedule omits sequence when the shell mapping is set (D112/D114)",
    );
    assert.deepEqual(created[0]?.senders.sort(), [
      "g1@canary-g.info",
      "o1@canary-o.info",
    ]);
    assert.equal(state.getCopyCanaryTestId(4), "t-1");
    assert.equal(result.testsEnsured, 2);
    assert.equal(state.isCopyCanary("g1@canary-g.info"), true);
  });

  it("asks Josh to buy the fleet when it is missing", async () => {
    const state = new StateStore(
      `/tmp/copy-canary-buy-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    const requested: string[] = [];
    const added: number[] = [];
    const smartlead = {
      listCampaigns: async () => [
        { id: 4, name: "Live", status: "ACTIVE", client_id: 2 },
      ],
      listAllEmailAccounts: async () => [],
      addEmailAccountsToCampaign: async (
        _campaignId: number,
        ids: number[],
      ) => {
        added.push(...ids);
      },
    } as unknown as SmartleadClient;

    const service = new CopyCanaryService(
      loadConfig({ ENABLE_COPY_CANARY: "true" }),
      smartlead,
      null,
      slackStub(requested),
      state,
    );

    const result = await service.attach({ dryRun: false });
    assert.deepEqual(added, []);
    assert.equal(result.buyRequested, true);
    assert.deepEqual(requested, ["buy_canary_fleet"]);
    assert.equal(state.getCopyCanaryFleet()?.status, "pending");
  });

  it("does not ask again after the fleet is already bought (D60)", async () => {
    const state = new StateStore(
      `/tmp/copy-canary-bought-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    const executed = buildIsolationAction({
      kind: "buy_canary_fleet",
      title: "Buy the unwarmed canary fleet",
      proof: "proof",
      detail: {
        domains: ["getcrosslaunchco.info", "crosslaunchcoget.info"],
        phase: "awaiting_mailboxes",
      },
    });
    state.upsertIsolationAction({
      ...executed,
      status: "executed",
      decidedBy: "Josh",
    });
    const leftover = buildIsolationAction({
      kind: "buy_canary_fleet",
      title: "Buy the unwarmed canary fleet",
      proof: "again",
      detail: {},
    });
    state.upsertIsolationAction(leftover);
    state.setCopyCanaryFleet({
      status: "pending",
      domains: [],
      emails: [],
      actionId: leftover.id,
      updatedAt: new Date().toISOString(),
    });

    const requested: string[] = [];
    const service = new CopyCanaryService(
      loadConfig({ ENABLE_COPY_CANARY: "true" }),
      {
        listCampaigns: async () => [],
        listAllEmailAccounts: async () => [],
      } as unknown as SmartleadClient,
      null,
      slackStub(requested),
      state,
    );

    const result = await service.attach({ dryRun: false });
    assert.equal(result.buyRequested, false);
    assert.deepEqual(requested, []);
    assert.deepEqual(state.getCopyCanaryFleet()?.domains, [
      "getcrosslaunchco.info",
      "crosslaunchcoget.info",
    ]);
    assert.equal(state.getCopyCanaryFleet()?.status, "awaiting_mailboxes");
    assert.equal(state.getIsolationAction(leftover.id)?.status, "denied");
  });

  it("does not use a pre-warmed fleet mailbox as a canary sender", async () => {
    const state = new StateStore(
      `/tmp/copy-canary-pre-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    seedFleet(state);
    state.upsertPoolMailbox({
      email: "hot@crosslaunchco.com",
      domain: "crosslaunchco.com",
      firstName: "Harmony",
      lastName: "Norris",
      platform: "GOOGLE",
      status: "warming",
      smartleadAccountId: 88,
      prewarmed: true,
      warmedAt: new Date().toISOString(),
    });

    const created: string[][] = [];
    const shells = shellSmartlead({
      listCampaigns: async () => [
        { id: 5, name: "Live", status: "ACTIVE", client_id: 2 },
        { id: 105, name: "Canary shell: #5 Live", status: "PAUSED" },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 11,
          from_email: "g1@canary-g.info",
          type: "GMAIL",
          campaign_ids: [],
        },
        {
          id: 12,
          from_email: "o1@canary-o.info",
          type: "OUTLOOK",
          campaign_ids: [],
        },
        {
          id: 88,
          from_email: "hot@crosslaunchco.com",
          type: "GMAIL",
          campaign_ids: [],
        },
      ],
      addEmailAccountsToCampaign: async (campaignId: number, ids: number[]) => {
        if (campaignId === 5) {
          throw new Error("must not add canaries to a live campaign");
        }
        shells.added.push({ campaignId, ids });
      },
      removeEmailAccountsFromCampaign: async () => undefined,
      updateEmailAccount: async () => undefined,
      configureWarmup: async () => undefined,
    });
    const smartlead = shells.api as unknown as SmartleadClient;

    const service = new CopyCanaryService(
      loadConfig({ ENABLE_COPY_CANARY: "true", AUTO_PLACEMENT_TESTS: "true" }),
      smartlead,
      {
        listTests: async () => [],
        resolveProviderIds: async () => [2, 20],
        createAutomatedPlacement: async (payload: {
          sender_accounts: string[];
        }) => {
          created.push(payload.sender_accounts);
          return { id: "t-1" };
        },
      } as unknown as SmartDeliveryClient,
      slackStub(),
      state,
    );

    await service.attach({ dryRun: false });
    assert.deepEqual(created[0]?.sort(), [
      "g1@canary-g.info",
      "o1@canary-o.info",
    ]);
    assert.ok(!created[0]?.includes("hot@crosslaunchco.com"));
  });

  it("D114: live copy with no mapping still schedules against the shell mapping", async () => {
    const state = new StateStore(
      `/tmp/copy-canary-nomap-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    seedFleet(state);
    const created: Array<{
      campaignId?: number;
      sequenceMappingId?: number;
      sequence?: unknown;
    }> = [];
    const shells = shellSmartlead({
      listCampaigns: async () => [
        { id: 5, name: "Live", status: "ACTIVE", client_id: 2 },
        { id: 105, name: "Canary shell: #5 Live", status: "PAUSED" },
      ],
      listAllEmailAccounts: async () => [
        { id: 11, from_email: "g1@canary-g.info", type: "GMAIL", campaign_ids: [] },
        { id: 12, from_email: "o1@canary-o.info", type: "OUTLOOK", campaign_ids: [] },
      ],
      getCampaignSequences: async (campaignId: number) => {
        if (campaignId === 5) return [{ subject: "Hi", email_body: "Body" }];
        return [{ id: 77, seq_number: 1, subject: "Hi", email_body: "Body" }];
      },
      removeEmailAccountsFromCampaign: async () => undefined,
      updateEmailAccount: async () => undefined,
      configureWarmup: async () => undefined,
    });

    const result = await new CopyCanaryService(
      loadConfig({ ENABLE_COPY_CANARY: "true", AUTO_PLACEMENT_TESTS: "true" }),
      shells.api as unknown as SmartleadClient,
      {
        listTests: async () => [],
        resolveProviderIds: async () => [2, 20],
        createAutomatedPlacement: async (payload: {
          campaign_id?: number;
          sequence_mapping_id?: number;
          sequence?: unknown;
        }) => {
          created.push({
            campaignId: payload.campaign_id,
            sequenceMappingId: payload.sequence_mapping_id,
            sequence: payload.sequence,
          });
          return { id: "t-nomap" };
        },
      } as unknown as SmartDeliveryClient,
      slackStub(),
      state,
    ).attach({ dryRun: false });

    assert.equal(result.testsEnsured, 1);
    assert.equal(created[0]?.campaignId, 105);
    assert.equal(created[0]?.sequenceMappingId, 77);
    assert.equal(created[0]?.sequence, undefined);
  });

  it("D98: ensureCopyTest fails loudly when no provider ids resolve", async () => {
    const state = new StateStore(
      `/tmp/copy-canary-noprov-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    seedFleet(state);
    const created: unknown[] = [];
    const shells = shellSmartlead({
      listCampaigns: async () => [
        { id: 5, name: "Live", status: "ACTIVE", client_id: 2 },
        { id: 105, name: "Canary shell: #5 Live", status: "PAUSED" },
      ],
      listAllEmailAccounts: async () => [
        { id: 11, from_email: "g1@canary-g.info", type: "GMAIL", campaign_ids: [] },
        { id: 12, from_email: "o1@canary-o.info", type: "OUTLOOK", campaign_ids: [] },
      ],
      removeEmailAccountsFromCampaign: async () => undefined,
      updateEmailAccount: async () => undefined,
      configureWarmup: async () => undefined,
    });
    const smartlead = shells.api as unknown as SmartleadClient;

    const result = await new CopyCanaryService(
      loadConfig({ ENABLE_COPY_CANARY: "true", AUTO_PLACEMENT_TESTS: "true" }),
      smartlead,
      {
        listTests: async () => [],
        resolveProviderIds: async () => [],
        createAutomatedPlacement: async () => {
          created.push(true);
          throw new Error("should not create");
        },
      } as unknown as SmartDeliveryClient,
      slackStub(),
      state,
    ).attach({ dryRun: false });

    assert.equal(created.length, 0);
    assert.equal(result.testsEnsured, 0);
    assert.ok(
      result.errors.some((row) => row.includes("no SmartDelivery provider_ids")),
    );
  });

  it("D98: a stored canary is reused when listTests is down", async () => {
    const state = new StateStore(
      `/tmp/copy-canary-reuse-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    seedFleet(state);
    state.setCopyCanaries(5, ["g1@canary-g.info", "o1@canary-o.info"], "existing-1");
    let created = 0;
    const smartlead = {
      listCampaigns: async () => [
        { id: 5, name: "Live", status: "ACTIVE", client_id: 2 },
      ],
      listAllEmailAccounts: async () => [
        { id: 11, from_email: "g1@canary-g.info", type: "GMAIL", campaign_ids: [] },
        { id: 12, from_email: "o1@canary-o.info", type: "OUTLOOK", campaign_ids: [] },
      ],
      getCampaignSequences: async () => [
        { id: 1, subject: "Hi", email_body: "Body" },
      ],
      addEmailAccountsToCampaign: async () => undefined,
      removeEmailAccountsFromCampaign: async () => undefined,
      updateEmailAccount: async () => undefined,
      configureWarmup: async () => undefined,
    } as unknown as SmartleadClient;

    const result = await new CopyCanaryService(
      loadConfig({ ENABLE_COPY_CANARY: "true", AUTO_PLACEMENT_TESTS: "true" }),
      smartlead,
      {
        listTests: async () => {
          throw new Error("list down");
        },
        resolveProviderIds: async () => [2, 20],
        createAutomatedPlacement: async () => {
          created += 1;
          return { id: "new-1" };
        },
      } as unknown as SmartDeliveryClient,
      slackStub(),
      state,
    ).attach({ dryRun: false });

    assert.equal(created, 0, "list failure must not spawn a second test");
    assert.equal(result.errors.length, 0);
    assert.equal(result.testsEnsured, 1);
    assert.equal(state.getCopyCanaryTestId(5), "existing-1");
  });

  it("D119: list failure still seeds the shell and does not schedule", async () => {
    const state = new StateStore(
      `/tmp/copy-canary-seed-list-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    seedFleet(state);
    const seeded: string[] = [];
    let created = 0;
    let listCalls = 0;
    const shells = shellSmartlead({
      listCampaigns: async () => [
        { id: 4, name: "Live A", status: "ACTIVE", client_id: 2 },
        { id: 104, name: "Canary shell: #4 Live A", status: "PAUSED" },
      ],
      listAllEmailAccounts: async () => [
        { id: 11, from_email: "g1@canary-g.info", type: "GMAIL", campaign_ids: [] },
        { id: 12, from_email: "o1@canary-o.info", type: "OUTLOOK", campaign_ids: [] },
      ],
      addLeadsToCampaign: async (
        _campaignId: number,
        leads: Array<{ email: string }>,
      ) => {
        seeded.push(leads[0]!.email);
        return {
          upload_count: 1,
          emailToLeadIdMap: {
            newlyAddedLeads: { [leads[0]!.email]: "1" },
          },
        };
      },
    });

    const result = await new CopyCanaryService(
      loadConfig({ ENABLE_COPY_CANARY: "true", AUTO_PLACEMENT_TESTS: "true" }),
      shells.api as unknown as SmartleadClient,
      {
        listTests: async () => {
          listCalls += 1;
          throw new Error("Rate limit exceeded");
        },
        resolveProviderIds: async () => [2, 20],
        createAutomatedPlacement: async () => {
          created += 1;
          return { id: "new-1" };
        },
      } as unknown as SmartDeliveryClient,
      slackStub(),
      state,
    ).attach({ dryRun: false });

    assert.equal(listCalls, 3, "listTests is retried before giving up");
    assert.deepEqual(seeded, ["canary.instrumentation.104@getcrosslaunchco.info"]);
    assert.equal(created, 0, "D98: list failure still must not spawn a test");
    assert.equal(result.testsEnsured, 0);
    assert.equal(
      result.errors.some((row) => row.includes("could not list SmartDelivery tests")),
      true,
    );
  });

  it("backfills a missing copy-canary testId on a PAUSED isolation suspect", async () => {
    const state = new StateStore(
      `/tmp/copy-canary-heal-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    seedFleet(state);
    state.setCopyCanaries(3748412, ["g1@canary-g.info", "o1@canary-o.info"]);
    state.markCopySuspect({
      campaignId: 3748412,
      campaignName: "SalesGlider Trades Airpods",
      at: "2026-08-26T12:00:00.000Z",
      evaluatedAt: "2026-08-26T12:05:00.000Z",
      reason: "missing unwarmed senders with that copy",
    });
    state.upsertIsolationRun({
      id: "06371d1b-768f-4e3b-9c52-ee08019f8341",
      campaignId: 3748412,
      campaignName: "SalesGlider Trades Airpods",
      startedAt: "2026-08-26T12:00:00.000Z",
      updatedAt: "2026-08-26T12:05:00.000Z",
      control: "INSUFFICIENT",
      verdict: "INCONCLUSIVE",
      campaignInSpam: true,
      reason: "missing unwarmed senders with that copy",
    });
    assert.equal(state.getCopyCanaryTestId(3748412), undefined);

    const created: string[] = [];
    const stopped: string[] = [];
    const shells = shellSmartlead({
      listCampaigns: async () => [
        { id: 3748412, name: "SalesGlider Trades Airpods", status: "PAUSED" },
        { id: 9001, name: "Canary shell: #3748412 SalesGlider", status: "PAUSED" },
      ],
      listAllEmailAccounts: async () => [
        { id: 11, from_email: "g1@canary-g.info", type: "GMAIL", campaign_ids: [] },
        { id: 12, from_email: "o1@canary-o.info", type: "OUTLOOK", campaign_ids: [] },
      ],
      removeEmailAccountsFromCampaign: async () => undefined,
      updateEmailAccount: async () => undefined,
      configureWarmup: async () => undefined,
    });

    const result = await new CopyCanaryService(
      loadConfig({ ENABLE_COPY_CANARY: "true", AUTO_PLACEMENT_TESTS: "true" }),
      shells.api as unknown as SmartleadClient,
      {
        listTests: async () => [],
        resolveProviderIds: async () => [2, 20],
        createAutomatedPlacement: async (payload: { test_name?: string }) => {
          created.push(String(payload.test_name ?? ""));
          return { id: "healed-3748412" };
        },
        stopAutomatedTest: async (testId: string) => {
          stopped.push(testId);
        },
      } as unknown as SmartDeliveryClient,
      slackStub(),
      state,
    ).attach({ dryRun: false });

    assert.equal(state.getCopyCanaryTestId(3748412), "healed-3748412");
    assert.ok(created.some((name) => name.includes("#3748412")));
    assert.deepEqual(stopped, [], "do not stop the test isolation still needs");
    assert.ok(result.testsEnsured >= 1);
  });

  it("persists a living listed testId when emails exist but state lost it", async () => {
    const state = new StateStore(
      `/tmp/copy-canary-recover-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    seedFleet(state);
    state.setCopyCanaries(3748412, ["g1@canary-g.info", "o1@canary-o.info"]);
    assert.equal(state.getCopyCanaryTestId(3748412), undefined);

    let created = 0;
    const shells = shellSmartlead({
      listCampaigns: async () => [
        { id: 3748412, name: "SalesGlider Trades Airpods", status: "PAUSED" },
      ],
      listAllEmailAccounts: async () => [
        { id: 11, from_email: "g1@canary-g.info", type: "GMAIL", campaign_ids: [] },
        { id: 12, from_email: "o1@canary-o.info", type: "OUTLOOK", campaign_ids: [] },
      ],
      removeEmailAccountsFromCampaign: async () => undefined,
      updateEmailAccount: async () => undefined,
      configureWarmup: async () => undefined,
    });

    await new CopyCanaryService(
      loadConfig({ ENABLE_COPY_CANARY: "true", AUTO_PLACEMENT_TESTS: "true" }),
      shells.api as unknown as SmartleadClient,
      {
        listTests: async () => [
          {
            id: "listed-3748412",
            test_name: "Canary copy: #3748412 SalesGlider Trades Airpods",
            status: "active",
            every_days: 1,
          },
        ],
        resolveProviderIds: async () => [2, 20],
        createAutomatedPlacement: async () => {
          created += 1;
          return { id: "should-not-create" };
        },
        stopAutomatedTest: async () => undefined,
      } as unknown as SmartDeliveryClient,
      slackStub(),
      state,
    ).attach({ dryRun: false });

    assert.equal(created, 0, "recover the living test — do not spawn a second");
    assert.equal(state.getCopyCanaryTestId(3748412), "listed-3748412");
  });
});
