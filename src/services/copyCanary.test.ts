import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
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

describe("CopyCanaryService", () => {
  it("attaches the dedicated fleet to every ACTIVE campaign and skips warming pool", async () => {
    const state = new StateStore(
      `/tmp/copy-canary-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
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
    state.upsertPoolMailbox({
      email: "cold@pool.info",
      domain: "pool.info",
      firstName: "Cold",
      lastName: "Box",
      platform: "GOOGLE",
      status: "warming",
      smartleadAccountId: 77,
      warmedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    });

    const added: Array<{ campaignId: number; ids: number[] }> = [];
    const warmup: Array<{ id: number; enabled: boolean }> = [];
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
          campaign_ids: [],
        },
        {
          id: 12,
          from_email: "o1@canary-o.info",
          type: "OUTLOOK",
          campaign_ids: [],
        },
        {
          id: 77,
          from_email: "cold@pool.info",
          type: "GMAIL",
          campaign_ids: [],
        },
      ],
      addEmailAccountsToCampaign: async (
        campaignId: number,
        ids: number[],
      ) => {
        added.push({ campaignId, ids });
      },
      updateEmailAccount: async () => undefined,
      configureWarmup: async (
        id: number,
        settings: { warmup_enabled: boolean },
      ) => {
        warmup.push({ id, enabled: settings.warmup_enabled });
      },
    } as unknown as SmartleadClient;

    const service = new CopyCanaryService(
      loadConfig({
        ENABLE_COPY_CANARY: "true",
        DRY_RUN: "false",
      }),
      smartlead,
      null,
      slackStub(),
      state,
    );

    const result = await service.attach({ dryRun: false });
    assert.equal(result.attached.length, 4);
    assert.deepEqual(
      added.flatMap((row) => row.ids).sort((a, b) => a - b),
      [11, 11, 12, 12],
    );
    assert.ok(!added.some((row) => row.ids.includes(77)));
    assert.deepEqual(state.getCopyCanaries(4).sort(), [
      "g1@canary-g.info",
      "o1@canary-o.info",
    ]);
    assert.deepEqual(state.getCopyCanaries(5).sort(), [
      "g1@canary-g.info",
      "o1@canary-o.info",
    ]);
    assert.equal(state.isCopyCanary("g1@canary-g.info"), true);
    assert.equal(state.isCopyCanary("cold@pool.info"), false);
    assert.ok(warmup.every((row) => row.enabled === false));
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
      updateEmailAccount: async () => undefined,
      configureWarmup: async () => undefined,
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
    const actions = state.listIsolationActions();
    assert.equal(actions[0]?.kind, "buy_canary_fleet");
    assert.equal(actions[0]?.status, "pending");
  });

  it("does not attach a pre-warmed fleet mailbox as a canary", async () => {
    const state = new StateStore(
      `/tmp/copy-canary-pre-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    state.setCopyCanaryFleet({
      status: "ready",
      domains: ["canary-g.info"],
      emails: ["g1@canary-g.info"],
      googleDomain: "canary-g.info",
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

    const added: number[] = [];
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
          id: 88,
          from_email: "hot@crosslaunchco.com",
          type: "GMAIL",
          campaign_ids: [],
        },
      ],
      addEmailAccountsToCampaign: async (
        _campaignId: number,
        ids: number[],
      ) => {
        added.push(...ids);
      },
      updateEmailAccount: async () => undefined,
      configureWarmup: async () => undefined,
    } as unknown as SmartleadClient;

    const service = new CopyCanaryService(
      loadConfig({ ENABLE_COPY_CANARY: "true" }),
      smartlead,
      null,
      slackStub(),
      state,
    );

    const result = await service.attach({ dryRun: false });
    assert.deepEqual(added, [11]);
    assert.equal(result.attached.length, 1);
    assert.ok(!added.includes(88));
  });
});
