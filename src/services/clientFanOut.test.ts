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
          from_email: "a@boldercyperpartnerbiz.info", created_at: "2026-06-01T00:00:00Z",
          campaign_ids: [1],
          client_id: 9,
        },
        {
          id: 101,
          from_email: "b@boldercyperpartnerbiz.info", created_at: "2026-06-01T00:00:00Z",
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
      isCopyCanary: () => false,
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
          from_email: "kyle@petersonroofs.com", created_at: "2026-06-01T00:00:00Z",
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
      isCopyCanary: () => false,
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
        { id: 100, from_email: "corey@techevo.com", created_at: "2026-06-01T00:00:00Z", campaign_ids: [], client_id: 7 },
        { id: 101, from_email: "onit@techevo.com", created_at: "2026-06-01T00:00:00Z", campaign_ids: [1], client_id: 7 },
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
      isCopyCanary: () => false,
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
          from_email: "idle@crosslaunchco.com", created_at: "2026-06-01T00:00:00Z",
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
      isCopyCanary: () => false,
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
          from_email: "spare@crosslaunchco.com", created_at: "2026-06-01T00:00:00Z",
          campaign_ids: [1],
          client_id: 9,
        },
        {
          id: 101,
          from_email: "rep@vasco.com", created_at: "2026-06-01T00:00:00Z",
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
      isCopyCanary: () => false,
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
          from_email: "idle@boldercyperpartnerhub.info", created_at: "2026-06-01T00:00:00Z",
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
      isCopyCanary: () => false,
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

describe("D139 — staffing never hands the gate its next pull", () => {
  it("a freshly imported client inbox waits out its 21 days; exempt inventory still flows", async () => {
    const adds: Array<[number, number[]]> = [];
    const fresh = new Date(Date.now() - 2.8 * 86_400_000).toISOString();
    const smartlead = {
      listCampaigns: async () => [
        { id: 1, name: "Parlay EOS", status: "ACTIVE", client_id: 5 },
        { id: 2, name: "Parlay Trendrr", status: "ACTIVE", client_id: 5 },
      ],
      listAllEmailAccounts: async () => [
        // 2.8 days old — the gate would pull it; fan-out must not re-add it
        {
          id: 100,
          from_email: "valentina.flores@getparlay.info",
          created_at: fresh,
          campaign_ids: [1],
          client_id: 5,
        },
        // warmed client inbox — still fans onto campaign 2
        {
          id: 101,
          from_email: "old.hand@getparlay.info",
          created_at: "2026-06-01T00:00:00Z",
          campaign_ids: [1],
          client_id: 5,
        },
        // young by clock but gate-exempt by tag — still fans
        {
          id: 102,
          from_email: "exempt@getparlay.info",
          created_at: fresh,
          campaign_ids: [1],
          client_id: 5,
          tags: [{ tag_name: "WARMUP-GATE-EXEMPT" }],
        },
      ],
      listClients: async () => [{ id: 5, name: "Parlay Tech" }],
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
      isCopyCanary: () => false,
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
    const added = adds.flatMap(([, ids]) => ids);
    assert.ok(!added.includes(100), "the 2.8-day inbox is not fanned out");
    assert.ok(added.includes(101), "the warmed inbox still fans out");
    assert.ok(added.includes(102), "the WARMUP-GATE-EXEMPT inbox still fans out");
    assert.ok(
      result.skipped.some((row) => row.includes("owes warmup")),
      `skip reason names the clock: ${result.skipped.join(" | ")}`,
    );
  });
});
