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
      getDomainHistory: () => undefined,
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

  it("D84: fans out a client inbox attached to zero group campaigns", async () => {
    const adds: Array<[number, number[]]> = [];
    const smartlead = {
      listCampaigns: async () => [
        { id: 1, name: "Peterson C1", status: "ACTIVE", client_id: 9 },
        { id: 2, name: "Peterson C2", status: "ACTIVE", client_id: 9 },
      ],
      listAllEmailAccounts: async () => [
        // Detached: client-owned but sitting on no campaign at all. The old
        // touches-the-group gate skipped it forever (TechEvo/Peterson at 1).
        {
          id: 100,
          from_email: "kyle@petersonroofs.com",
          campaign_ids: [],
          client_id: 9,
        },
      ],
      listClients: async () => [{ id: 9, name: "Roofs by Peterson" }],
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
        getDomainHistory: () => undefined,
      } as unknown as StateStore,
    );

    const result = await service.run({ dryRun: false });
    assert.deepEqual(
      adds.map(([id]) => id).sort((a, b) => a - b),
      [1, 2],
      "a detached client inbox must reach every ACTIVE campaign for its client",
    );
    assert.equal(result.attached.length, 2);
  });

  it("D84: a single-campaign group still gets its detached inboxes", async () => {
    const adds: Array<[number, number[]]> = [];
    const smartlead = {
      listCampaigns: async () => [
        { id: 1, name: "TechEvo Red Sox", status: "ACTIVE", client_id: 7 },
      ],
      listAllEmailAccounts: async () => [
        { id: 100, from_email: "corey@techevo.com", campaign_ids: [], client_id: 7 },
        { id: 101, from_email: "onit@techevo.com", campaign_ids: [1], client_id: 7 },
      ],
      listClients: async () => [{ id: 7, name: "TechEvolution" }],
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
        getDomainHistory: () => undefined,
      } as unknown as StateStore,
    );

    const result = await service.run({ dryRun: false });
    assert.deepEqual(adds, [[1, [100]]]);
    assert.equal(result.attached.length, 1);
  });

  it("D84: an idle pool generic stays top-up supply, not fan-out supply", async () => {
    const adds: Array<[number, number[]]> = [];
    const smartlead = {
      listCampaigns: async () => [
        { id: 1, name: "Vasco A", status: "ACTIVE", client_id: 9 },
        { id: 2, name: "Vasco B", status: "ACTIVE", client_id: 9 },
      ],
      listAllEmailAccounts: async () => [
        // Pre-warmed fleet generic branded to the client but idle (no
        // memberships). Fan-out must leave it for top-up.
        {
          id: 100,
          from_email: "idle@crosslaunchco.com",
          campaign_ids: [],
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
        getDomainHistory: () => undefined,
      } as unknown as StateStore,
    );

    await service.run({ dryRun: false });
    assert.deepEqual(adds, [], "idle generics are not fan-out supply");
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
        getDomainHistory: () => undefined,
      } as unknown as StateStore,
    );

    const result = await service.run({ dryRun: false });
    assert.deepEqual(adds, [[2, [101]]]);
    assert.ok(result.skipped.some((row) => row.includes("spare@crosslaunchco.com")));
  });

  it("D99: a BCP-owned inbox with no client_id still fans onto tagged BCP campaigns", async () => {
    const adds: Array<[number, number[]]> = [];
    const smartlead = {
      listCampaigns: async () => [
        { id: 1, name: "BCP Healthcare Over-1k (No Team)", status: "ACTIVE", client_id: 9 },
        { id: 2, name: "BCP Logistics Over-1k (No Team)", status: "ACTIVE", client_id: 9 },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 100,
          from_email: "idle@boldercyperpartnerhub.info",
          campaign_ids: [],
          client_id: null,
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

    const result = await new ClientFanOutService(
      loadConfig({}),
      smartlead,
      { send: async () => undefined } as unknown as SlackClient,
      {
        getPoolMailbox: () => undefined,
        getHeldInbox: () => undefined,
        getRestingInbox: () => undefined,
        getDomainHistory: () => undefined,
      } as unknown as StateStore,
    ).run({ dryRun: false });

    assert.deepEqual(
      adds.map(([id]) => id).sort((a, b) => a - b),
      [1, 2],
    );
    assert.equal(result.attached.length, 2);
  });
});
