import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import type { StateStore } from "../state/store.js";
import { ClientFanOutService } from "./clientFanOut.js";

describe("ClientFanOutService", () => {
  it("batches BCP mailbox adds onto every ACTIVE BCP campaign missing them", async () => {
    const adds: Array<[number, number[]]> = [];
    const smartlead = {
      listCampaigns: async () => [
        { id: 1, name: "BCP PE", status: "ACTIVE", client_id: 9 },
        { id: 2, name: "BCP Logistics", status: "ACTIVE", client_id: 9 },
        { id: 3, name: "Other", status: "ACTIVE", client_id: 2 },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 100,
          from_email: "a@boldercyperpartnerbiz.info",
          campaign_ids: [1],
          client_id: 9,
        },
        {
          id: 101,
          from_email: "b@boldercyperpartnerbiz.info",
          campaign_ids: [1],
          client_id: 9,
        },
      ],
      listClients: async () => [{ id: 9, name: "BCP" }],
      addEmailAccountsToCampaign: async (
        campaignId: number,
        ids: number[],
      ) => {
        adds.push([campaignId, [...ids]]);
      },
      updateEmailAccount: async () => undefined,
    } as unknown as SmartleadClient;

    const state = {
      getPoolMailbox: () => undefined,
      getHeldInbox: () => undefined,
      getRestingInbox: () => undefined,
    } as unknown as StateStore;

    const service = new ClientFanOutService(
      loadConfig({}),
      smartlead,
      { send: async () => undefined } as unknown as SlackClient,
      state,
    );

    const result = await service.run({ dryRun: false });
    assert.equal(result.attached.length, 2);
    assert.deepEqual(adds, [[2, [100, 101]]]);
    assert.ok(result.attached.every((a) => a.campaignId === 2));
  });

  it("does not fan generics onto a non-Goliath client (D58)", async () => {
    const adds: Array<[number, number[]]> = [];
    const smartlead = {
      listCampaigns: async () => [
        { id: 1, name: "Vasco A", status: "ACTIVE", client_id: 9 },
        { id: 2, name: "Vasco B", status: "ACTIVE", client_id: 9 },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 100,
          from_email: "spare@crosslaunchco.com",
          campaign_ids: [1],
          client_id: 9,
        },
        {
          id: 101,
          from_email: "rep@vasco.com",
          campaign_ids: [1],
          client_id: 9,
        },
      ],
      listClients: async () => [{ id: 9, name: "Vasco Warranty" }],
      addEmailAccountsToCampaign: async (
        campaignId: number,
        ids: number[],
      ) => {
        adds.push([campaignId, [...ids]]);
      },
      updateEmailAccount: async () => undefined,
    } as unknown as SmartleadClient;

    const service = new ClientFanOutService(
      loadConfig({}),
      smartlead,
      { send: async () => undefined } as unknown as SlackClient,
      {
        getPoolMailbox: () => undefined,
        getHeldInbox: () => undefined,
        getRestingInbox: () => undefined,
      } as unknown as StateStore,
    );

    const result = await service.run({ dryRun: false });
    assert.deepEqual(adds, [[2, [101]]]);
    assert.ok(result.skipped.some((row) => row.includes("spare@crosslaunchco.com")));
  });
});
