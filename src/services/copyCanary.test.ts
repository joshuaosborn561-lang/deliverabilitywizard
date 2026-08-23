import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import { StateStore } from "../state/store.js";
import { CopyCanaryService } from "./copyCanary.js";

describe("CopyCanaryService", () => {
  it("attaches still-warming pool generics to an ACTIVE campaign", async () => {
    const state = new StateStore(
      `/tmp/copy-canary-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
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

    const added: number[] = [];
    const smartlead = {
      listCampaigns: async () => [
        { id: 4, name: "Live", status: "ACTIVE", client_id: 2 },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 77,
          from_email: "cold@pool.info",
          type: "GMAIL",
          campaign_ids: [],
          client_id: null,
        },
      ],
      listClients: async () => [{ id: 2, name: "Parlay" }],
      addEmailAccountsToCampaign: async (
        campaignId: number,
        ids: number[],
      ) => {
        added.push(...ids);
        void campaignId;
      },
      updateEmailAccount: async () => undefined,
    } as unknown as SmartleadClient;

    const service = new CopyCanaryService(
      loadConfig({
        ENABLE_COPY_CANARY: "true",
        COPY_CANARY_PER_CAMPAIGN: "1",
        DRY_RUN: "false",
      }),
      smartlead,
      null,
      { send: async () => undefined } as unknown as SlackClient,
      state,
    );

    const result = await service.attach({ dryRun: false });
    assert.deepEqual(added, [77]);
    assert.equal(result.attached.length, 1);
    assert.deepEqual(state.getCopyCanaries(4), ["cold@pool.info"]);
    assert.equal(state.isCopyCanary("cold@pool.info"), true);
  });

  it("does not attach a pre-warmed fleet mailbox", async () => {
    const state = new StateStore(
      `/tmp/copy-canary-pre-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
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
          id: 88,
          from_email: "hot@crosslaunchco.com",
          type: "GMAIL",
          campaign_ids: [],
        },
      ],
      listClients: async () => [{ id: 2, name: "Parlay" }],
      addEmailAccountsToCampaign: async (
        _campaignId: number,
        ids: number[],
      ) => {
        added.push(...ids);
      },
      updateEmailAccount: async () => undefined,
    } as unknown as SmartleadClient;

    const service = new CopyCanaryService(
      loadConfig({ ENABLE_COPY_CANARY: "true", COPY_CANARY_PER_CAMPAIGN: "1" }),
      smartlead,
      null,
      { send: async () => undefined } as unknown as SlackClient,
      state,
    );

    const result = await service.attach({ dryRun: false });
    assert.deepEqual(added, []);
    assert.equal(result.attached.length, 0);
  });
});
