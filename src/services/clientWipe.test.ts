import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import { StateStore } from "../state/store.js";
import { ClientWipeService } from "./clientWipe.js";

describe("ClientWipeService", () => {
  it("keeps 40 Vasco by mix and wipes GXA / MSRS / Nieto (D61)", async () => {
    const state = new StateStore(
      `/tmp/client-wipe-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    const deleted: number[] = [];
    const removed: Array<{ campaignId: number; ids: number[] }> = [];
    const vasco = [
      ...Array.from({ length: 50 }, (_, i) => ({
        id: 100 + i,
        from_email: `g${String(i).padStart(2, "0")}@vasco.com`,
        client_id: 9,
        type: "GMAIL",
        campaign_ids: i < 25 ? [1] : [],
      })),
      ...Array.from({ length: 30 }, (_, i) => ({
        id: 200 + i,
        from_email: `m${String(i).padStart(2, "0")}@vasco.com`,
        client_id: 9,
        type: "OUTLOOK",
        campaign_ids: i < 15 ? [1] : [],
      })),
    ];
    const others = [
      {
        id: 301,
        from_email: "a@gxa.com",
        client_id: 11,
        type: "GMAIL",
        campaign_ids: [2],
      },
      {
        id: 302,
        from_email: "b@msrs.info",
        client_id: 12,
        type: "OUTLOOK",
        campaign_ids: [3],
      },
      {
        id: 303,
        from_email: "c@nieto.com",
        client_id: 13,
        type: "GMAIL",
        campaign_ids: [4],
      },
      {
        id: 304,
        from_email: "keep@parlay.com",
        client_id: 14,
        type: "GMAIL",
        campaign_ids: [5],
      },
    ];
    const smartlead = {
      listCampaigns: async () => [
        { id: 1, name: "Vasco - Service", status: "ACTIVE", client_id: 9 },
        { id: 2, name: "GXA", status: "ACTIVE", client_id: 11 },
        { id: 3, name: "MSRS2 Ticket Offer", status: "ACTIVE", client_id: 12 },
        { id: 4, name: "Nieto", status: "PAUSED", client_id: 13 },
        { id: 5, name: "Parlay", status: "ACTIVE", client_id: 14 },
      ],
      listClients: async () => [
        { id: 9, name: "Vasco Warranty" },
        { id: 11, name: "GXA" },
        { id: 12, name: "MSRS" },
        { id: 13, name: "Nieto" },
        { id: 14, name: "Parlay" },
      ],
      listAllEmailAccounts: async () => [...vasco, ...others],
      removeEmailAccountsFromCampaign: async (
        campaignId: number,
        ids: number[],
      ) => {
        removed.push({ campaignId, ids });
      },
      deleteEmailAccount: async (id: number) => {
        deleted.push(id);
      },
    } as unknown as SmartleadClient;

    const slackLines: string[] = [];
    const service = new ClientWipeService(
      loadConfig({ ENABLE_CLIENT_WIPE: "true", DRY_RUN: "false" }),
      smartlead,
      null,
      { send: async (text: string) => slackLines.push(text) } as unknown as SlackClient,
      state,
    );
    const result = await service.run({ dryRun: false });
    assert.equal(result.skipped, false);
    assert.equal(result.vascoKept.length, 40);
    assert.equal(result.vascoDeleted.length, 40);
    assert.equal(result.wiped.length, 3);
    assert.ok(result.wiped.includes("a@gxa.com"));
    assert.ok(result.wiped.includes("b@msrs.info"));
    assert.ok(result.wiped.includes("c@nieto.com"));
    assert.ok(!deleted.includes(304));
    assert.equal(state.getClientWipeAt() != null, true);
    assert.match(slackLines[0] ?? "", /Vasco is down to 40/);
    assert.match(slackLines[0] ?? "", /GXA \/ MSRS \/ Nieto/);

    const again = await service.run({ dryRun: false });
    assert.equal(again.skipped, true);
  });

  it("does not delete a pool generic even if it sat on MSRS", async () => {
    const state = new StateStore(
      `/tmp/client-wipe-pool-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    state.upsertPoolMailbox({
      email: "spare@pool.info",
      domain: "pool.info",
      firstName: "Spare",
      lastName: "Box",
      platform: "GOOGLE",
      status: "available",
      smartleadAccountId: 9,
    });
    const deleted: number[] = [];
    const service = new ClientWipeService(
      loadConfig({ ENABLE_CLIENT_WIPE: "true", DRY_RUN: "false" }),
      {
        listCampaigns: async () => [
          { id: 3, name: "MSRS2", status: "ACTIVE", client_id: 12 },
        ],
        listClients: async () => [{ id: 12, name: "MSRS" }],
        listAllEmailAccounts: async () => [
          {
            id: 9,
            from_email: "spare@pool.info",
            client_id: 12,
            type: "GMAIL",
            campaign_ids: [3],
          },
        ],
        deleteEmailAccount: async (id: number) => {
          deleted.push(id);
        },
        removeEmailAccountsFromCampaign: async () => undefined,
      } as unknown as SmartleadClient,
      null,
      { send: async () => undefined } as unknown as SlackClient,
      state,
    );
    const result = await service.run({ dryRun: false });
    assert.deepEqual(deleted, []);
    assert.deepEqual(result.wiped, []);
  });
});
