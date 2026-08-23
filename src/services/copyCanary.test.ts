import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartDeliveryClient } from "../clients/smartdelivery.js";
import type { SmartleadClient } from "../clients/smartlead.js";
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
    const created: Array<{ name?: string; senders: string[] }> = [];
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
      createAutomatedPlacement: async (payload: {
        test_name?: string;
        sender_accounts: string[];
      }) => {
        created.push({
          name: payload.test_name,
          senders: payload.sender_accounts,
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
});
