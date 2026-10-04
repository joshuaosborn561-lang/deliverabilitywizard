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
    assert.ok(
      adds.some((row) => row[0] === 2 && row[1].includes(100)),
      "assigned same-client generic shares onto Vasco B (D229)",
    );
    assert.ok(
      adds.some((row) => row[0] === 2 && row[1].includes(101)),
      "named Vasco seat still fans",
    );
    void result;
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

  it("D184: does not fan ACTIVE SG seats onto Insight, or Insight seats onto ACTIVE SG", async () => {
    const adds: Array<[number, number[]]> = [];
    const smartlead = {
      listCampaigns: async () => [
        {
          id: 3921647,
          name: "Insight Consolidation Gateway SEG",
          status: "ACTIVE",
          client_id: 345263,
        },
        {
          id: 3921651,
          name: "Insight other",
          status: "ACTIVE",
          client_id: 345263,
        },
        {
          id: 89,
          name: "SalesGlider Nurture",
          status: "ACTIVE",
          client_id: 345263,
        },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 44,
          from_email: "insight@salesglidertop.org",
          created_at: "2026-06-01T00:00:00Z",
          campaign_ids: [3921647],
          client_id: 345263,
        },
        {
          id: 68,
          from_email: "engager@salesglidertop.org",
          created_at: "2026-06-01T00:00:00Z",
          campaign_ids: [89],
          client_id: 345263,
        },
      ],
      listClients: async () => [{ id: 345263, name: "SalesGlider" }],
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

    await service.run({ dryRun: false });
    assert.deepEqual(adds, [[3921651, [44]]]);
  });

  it("D229: assigned same-client generics share; rotating extras do not dump", async () => {
    const adds: Array<[number, number[]]> = [];
    const smartlead = {
      listCampaigns: async () => [
        {
          id: 3847798,
          name: "TechEvo NE IT DM v2 Red Sox",
          status: "ACTIVE",
          client_id: 521881,
        },
        {
          id: 3847800,
          name: "TechEvo NE IT DM v2 Patriots",
          status: "ACTIVE",
          client_id: 521881,
        },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 11,
          from_email: "ada@trygetintroduced.info",
          created_at: "2026-06-01T00:00:00Z",
          from_name: "Ada Pool",
          signature: "Ada Pool\nTechEvolution",
          campaign_ids: [3847798],
          client_id: 521881,
          tags: [{ tag_name: "GENERIC" }, { tag_name: "POD-A" }],
        },
        {
          id: 12,
          from_email: "spare@trygetintroduced.info",
          created_at: "2026-06-01T00:00:00Z",
          from_name: "Spare Pool",
          campaign_ids: [3847798],
          client_id: null,
          tags: [{ tag_name: "GENERIC" }],
        },
        {
          id: 22,
          from_email: "corey@techevo.com",
          created_at: "2026-06-01T00:00:00Z",
          campaign_ids: [3847798],
          client_id: 521881,
        },
      ],
      listClients: async () => [
        { id: 521881, name: "TechEvolution", logo: "TechEvolution" },
      ],
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
        listGenericBackfillApprovals: () => ({
          "3847798": {
            campaignId: 3847798,
            approvedAt: "2026-09-01T00:00:00Z",
            approvedBy: "josh",
          },
          "3847800": {
            campaignId: 3847800,
            approvedAt: "2026-09-01T00:00:00Z",
            approvedBy: "josh",
          },
        }),
      } as unknown as StateStore,
    );

    const result = await service.run({
      dryRun: false,
      now: new Date("2026-10-05T15:00:00.000Z"),
    });
    assert.ok(
      adds.some((row) => row[0] === 3847800 && row[1].includes(11)),
      "assigned TechEvo generic shares onto the sibling campaign",
    );
    assert.ok(
      adds.some((row) => row[0] === 3847800 && row[1].includes(22)),
      "named TechEvo seat still fans",
    );
    assert.equal(
      adds.some((row) => row[1].includes(12)),
      false,
      "rotating unassigned generic is not dumped onto TechEvo",
    );
    assert.ok(
      result.skipped.some((row) => row.includes("spare@trygetintroduced.info")),
    );
  });

  it("D229: does not re-spread an off-week POD-B seat onto Insight", async () => {
    const adds: Array<[number, number[]]> = [];
    const smartlead = {
      listCampaigns: async () => [
        {
          id: 3921647,
          name: "Insight Consolidation Gateway SEG",
          status: "ACTIVE",
          client_id: 582890,
        },
        {
          id: 3921651,
          name: "Insight Pipeline B",
          status: "ACTIVE",
          client_id: 582890,
        },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 30,
          from_email: "off@joshpersonal.com",
          created_at: "2026-06-01T00:00:00Z",
          campaign_ids: [3921647],
          client_id: 582890,
          tags: [{ tag_name: "POD-B" }],
        },
      ],
      listClients: async () => [
        { id: 582890, name: "Insight", logo: "Insight" },
      ],
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

    const result = await service.run({
      dryRun: false,
      now: new Date("2026-10-05T15:00:00.000Z"),
    });
    assert.deepEqual(adds, []);
    assert.ok(result.skipped.some((row) => row.includes("off-week POD")));
  });
});
