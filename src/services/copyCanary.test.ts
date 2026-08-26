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
  it("schedules campaign-copy tests and never adds canaries to campaigns", async () => {
    const state = new StateStore(
      `/tmp/copy-canary-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    seedFleet(state);

    const added: number[] = [];
    const removed: Array<{ campaignId: number; ids: number[] }> = [];
    const created: Array<{
      name?: string;
      senders: string[];
      campaignId?: number;
      sequenceMappingId?: number;
      sequence?: unknown;
    }> = [];
    const smartlead = {
      listCampaigns: async () => [
        { id: 4, name: "Live A", status: "ACTIVE", client_id: 2 },
        { id: 5, name: "Live B", status: "ACTIVE", client_id: 9 },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 11,
          from_email: "g1@canary-g.info",
          type: "GMAIL",
          campaign_ids: [4],
        },
        {
          id: 12,
          from_email: "o1@canary-o.info",
          type: "OUTLOOK",
          campaign_ids: [],
        },
      ],
      getCampaignSequences: async () => [
        {
          id: 1,
          subject: "Quick look",
          email_body: "<div>Campaign copy</div>",
        },
      ],
      addEmailAccountsToCampaign: async (
        _campaignId: number,
        ids: number[],
      ) => {
        added.push(...ids);
      },
      removeEmailAccountsFromCampaign: async (
        campaignId: number,
        ids: number[],
      ) => {
        removed.push({ campaignId, ids });
      },
      updateEmailAccount: async () => undefined,
      configureWarmup: async () => undefined,
    } as unknown as SmartleadClient;
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
    assert.deepEqual(added, []);
    assert.deepEqual(removed, [{ campaignId: 4, ids: [11] }]);
    assert.equal(created.length, 2);
    assert.ok(created.every((row) => row.name?.startsWith("Canary copy:")));
    assert.deepEqual(
      created.map((row) => row.campaignId).sort((a, b) => (a ?? 0) - (b ?? 0)),
      [4, 5],
      "schedule requires campaign_id even though canaries stay off the campaign",
    );
    assert.ok(
      created.every((row) => row.sequenceMappingId === 1),
      "schedule requires sequence_mapping_id from the campaign sequence",
    );
    assert.ok(
      created.every((row) => row.sequence === undefined),
      "schedule omits sequence when sequence_mapping_id is set (D112)",
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
    const smartlead = {
      listCampaigns: async () => [
        { id: 5, name: "Live", status: "ACTIVE", client_id: 2 },
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
      getCampaignSequences: async () => [
        { id: 1, subject: "Hi", email_body: "Body" },
      ],
      addEmailAccountsToCampaign: async () => {
        throw new Error("must not add canaries to a campaign");
      },
      removeEmailAccountsFromCampaign: async () => undefined,
      updateEmailAccount: async () => undefined,
      configureWarmup: async () => undefined,
    } as unknown as SmartleadClient;

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

  it("D102: ensureCopyTest fails loudly when the sequence has no mapping id", async () => {
    const state = new StateStore(
      `/tmp/copy-canary-nomap-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    seedFleet(state);
    const created: unknown[] = [];
    const smartlead = {
      listCampaigns: async () => [
        { id: 5, name: "Live", status: "ACTIVE", client_id: 2 },
      ],
      listAllEmailAccounts: async () => [
        { id: 11, from_email: "g1@canary-g.info", type: "GMAIL", campaign_ids: [] },
        { id: 12, from_email: "o1@canary-o.info", type: "OUTLOOK", campaign_ids: [] },
      ],
      getCampaignSequences: async () => [
        { subject: "Hi", email_body: "Body" },
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
        listTests: async () => [],
        resolveProviderIds: async () => [2, 20],
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
      result.errors.some((row) => row.includes("no sequence_mapping_id")),
    );
  });

  it("D98: ensureCopyTest fails loudly when no provider ids resolve", async () => {
    const state = new StateStore(
      `/tmp/copy-canary-noprov-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    seedFleet(state);
    const created: unknown[] = [];
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
});
