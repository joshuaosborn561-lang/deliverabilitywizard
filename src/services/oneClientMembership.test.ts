import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import { StateStore } from "../state/store.js";
import { OneClientMembershipService } from "./oneClientMembership.js";

function padAccounts(
  campaignId: number,
  clientId: number,
  count = 40,
  idStart = 500,
): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => ({
    id: idStart + i,
    from_email: `pad-${i}@client.test`,
    client_id: clientId,
    campaign_ids: [campaignId],
  }));
}

function serviceWith(
  smartlead: Partial<SmartleadClient>,
  state?: StateStore,
): OneClientMembershipService {
  const store =
    state ??
    new StateStore(
      `/tmp/one-client-${process.pid}-${Date.now()}-${Math.random()}.json`,
    );
  return new OneClientMembershipService(
    loadConfig({ DRY_RUN: "false" }),
    {
      listClients: async () => [],
      addEmailAccountsToCampaign: async () => undefined,
      removeEmailAccountsFromCampaign: async () => undefined,
      updateEmailAccount: async () => undefined,
      ...smartlead,
    } as unknown as SmartleadClient,
    store,
  );
}

describe("OneClientMembershipService", () => {
  it("pulls a Goliath inbox off a Peterson campaign and rewrites the sig (D75)", async () => {
    const removed: Array<[number, number[]]> = [];
    const updates: Array<{ id: number; fields: Record<string, unknown> }> = [];
    const service = serviceWith({
      listCampaigns: async () => [
        { id: 1, name: "Goliath Displacement M", status: "ACTIVE", client_id: 548611 },
        { id: 2, name: "Peterson C3", status: "ACTIVE", client_id: 99 },
        { id: 9, name: "Pod control shell", status: "PAUSED", client_id: 548611 },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 11,
          from_email: "aarav@pool.info",
          from_name: "Aarav Sanchez",
          signature: "Aarav Sanchez\nRoofs by Peterson",
          client_id: 548611,
          campaign_ids: [1, 2, 9],
        },
        ...padAccounts(2, 99),
      ],
      listClients: async () => [
        { id: 548611, name: "Dave Ackley", logo: "Goliath Cybersecurity" },
        { id: 99, name: "Peterson", logo: "Roofs by Peterson" },
      ],
      removeEmailAccountsFromCampaign: async (campaignId: number, ids: number[]) => {
        removed.push([campaignId, [...ids]]);
      },
      updateEmailAccount: async (id: number, fields: Record<string, unknown>) => {
        updates.push({ id, fields });
      },
    });

    const result = await service.run({ dryRun: false });
    assert.deepEqual(removed, [[2, [11]]]);
    assert.equal(result.pulled[0]?.email, "aarav@pool.info");
    assert.equal(result.signaturesSet, 1);
    assert.equal(updates[0]?.fields.signature, "Aarav Sanchez\nGoliath Cybersecurity");
  });

  it("treats an undedicated rotating generic as Goliath and restores it (D76)", async () => {
    const removed: Array<[number, number[]]> = [];
    const added: Array<[number, number[]]> = [];
    const updates: Array<{ id: number; fields: Record<string, unknown> }> = [];
    const service = serviceWith({
      listCampaigns: async () => [
        { id: 1, name: "Goliath Displacement M", status: "ACTIVE", client_id: 548611 },
        { id: 3, name: "Goliath Displacement L", status: "ACTIVE", client_id: 548611 },
        { id: 8, name: "Goliath L1 AirPods", status: "STOPPED", client_id: 548611 },
        { id: 2, name: "Peterson C3", status: "ACTIVE", client_id: 548610 },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 11,
          from_email: "aaravsanchez@getoutreachdesk.info",
          from_name: "Aarav Sanchez",
          signature: "Aarav Sanchez\nGoliath Cybersecurity",
          client_id: null,
          campaign_ids: [2],
        },
        ...padAccounts(2, 548610),
      ],
      listClients: async () => [
        { id: 548611, name: "Dave Ackley", logo: "Goliath Cybersecurity" },
        { id: 548610, name: "Peterson", logo: "Roofs by Peterson" },
      ],
      addEmailAccountsToCampaign: async (campaignId: number, ids: number[]) => {
        added.push([campaignId, [...ids]]);
      },
      removeEmailAccountsFromCampaign: async (campaignId: number, ids: number[]) => {
        removed.push([campaignId, [...ids]]);
      },
      updateEmailAccount: async (id: number, fields: Record<string, unknown>) => {
        updates.push({ id, fields });
      },
    });

    const result = await service.run({ dryRun: false });
    assert.deepEqual(added, [
      [1, [11]],
      [3, [11]],
    ]);
    assert.deepEqual(removed, [[2, [11]]]);
    assert.equal(result.restored.length, 2);
    assert.equal(result.pulled[0]?.email, "aaravsanchez@getoutreachdesk.info");
    assert.equal(
      result.signaturesSet,
      0,
      "already Goliath-signed; D199 exclusive+Peterson-sig would have been dedicated",
    );
    void updates;
  });

  it("D198: a dedicated generic on Peterson is not peeled or rewritten to Goliath", async () => {
    const removed: Array<[number, number[]]> = [];
    const added: Array<[number, number[]]> = [];
    const updates: Array<{ id: number; fields: Record<string, unknown> }> = [];
    const service = serviceWith({
      listCampaigns: async () => [
        { id: 1, name: "Goliath Displacement M", status: "ACTIVE", client_id: 548611 },
        { id: 2, name: "Peterson C3", status: "ACTIVE", client_id: 548610 },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 11,
          from_email: "aaravsanchez@getoutreachdesk.info",
          from_name: "Aarav Sanchez",
          signature: "Aarav Sanchez\nRoofs by Peterson",
          client_id: 548610,
          campaign_ids: [2],
        },
        ...padAccounts(2, 548610),
      ],
      listClients: async () => [
        { id: 548611, name: "Dave Ackley", logo: "Goliath Cybersecurity" },
        { id: 548610, name: "Peterson", logo: "Roofs by Peterson" },
      ],
      addEmailAccountsToCampaign: async (campaignId: number, ids: number[]) => {
        added.push([campaignId, [...ids]]);
      },
      removeEmailAccountsFromCampaign: async (campaignId: number, ids: number[]) => {
        removed.push([campaignId, [...ids]]);
      },
      updateEmailAccount: async (id: number, fields: Record<string, unknown>) => {
        updates.push({ id, fields });
      },
    });

    const result = await service.run({ dryRun: false });
    assert.deepEqual(removed, []);
    assert.deepEqual(added, []);
    assert.equal(result.pulled.length, 0);
    assert.equal(result.restored.length, 0);
    assert.equal(result.signaturesSet, 0);
    assert.deepEqual(updates, []);
  });

  it("D198: a dedicated named-client generic on a Goliath shell is not dumped onto live Goliath", async () => {
    const added: Array<[number, number[]]> = [];
    const removed: Array<[number, number[]]> = [];
    const updates: Array<{ id: number; fields: Record<string, unknown> }> = [];
    const service = serviceWith({
      listCampaigns: async () => [
        { id: 1, name: "Goliath Displacement M", status: "ACTIVE", client_id: 548611 },
        { id: 4, name: "Goliath Education Receipts", status: "ACTIVE" },
        { id: 8, name: "Goliath L1 AirPods", status: "STOPPED", client_id: 548611 },
        { id: 9, name: "Pod control shell", status: "PAUSED", client_id: 548611 },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 11,
          from_email: "aaravsanchez@getoutreachdesk.info",
          from_name: "Aarav Sanchez",
          signature: "Aarav Sanchez\nRoofs by Peterson",
          client_id: 548610,
          campaign_ids: [9],
        },
      ],
      listClients: async () => [
        { id: 548611, name: "Dave Ackley", logo: "Goliath Cybersecurity" },
        { id: 548610, name: "Peterson", logo: "Roofs by Peterson" },
      ],
      addEmailAccountsToCampaign: async (campaignId: number, ids: number[]) => {
        added.push([campaignId, [...ids]]);
      },
      removeEmailAccountsFromCampaign: async (campaignId: number, ids: number[]) => {
        removed.push([campaignId, [...ids]]);
      },
      updateEmailAccount: async (id: number, fields: Record<string, unknown>) => {
        updates.push({ id, fields });
      },
    });

    const result = await service.run({ dryRun: false });
    assert.deepEqual(added, []);
    assert.deepEqual(removed, []);
    assert.equal(result.restored.length, 0);
    assert.equal(result.signaturesSet, 0);
    assert.deepEqual(updates, []);
  });

  it("does not dump a shell-only extra with no client_id onto Goliath", async () => {
    const added: Array<[number, number[]]> = [];
    const service = serviceWith({
      listCampaigns: async () => [
        { id: 1, name: "Goliath Displacement M", status: "ACTIVE", client_id: 548611 },
        { id: 9, name: "Pod control shell", status: "PAUSED", client_id: 548611 },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 22,
          from_email: "hnorris@crosslaunchco.com",
          from_name: "Harmony Norris",
          signature: "Harmony Norris\nGoliath Cybersecurity",
          campaign_ids: [9],
        },
      ],
      listClients: async () => [
        { id: 548611, name: "Dave Ackley", logo: "Goliath Cybersecurity" },
      ],
      addEmailAccountsToCampaign: async (campaignId: number, ids: number[]) => {
        added.push([campaignId, [...ids]]);
      },
    });

    const result = await service.run({ dryRun: false });
    assert.deepEqual(added, []);
    assert.equal(result.restored.length, 0);
  });

  it("clears a leftover Generic/POC client_id and does not write Goliath (D160)", async () => {
    const updates: Array<{ id: number; fields: Record<string, unknown> }> = [];
    const tagged: number[][] = [];
    const state = new StateStore(
      `/tmp/one-client-d160-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    state.setMarkerClientIds({ genericId: 900001, pocId: 900002 });
    const service = new OneClientMembershipService(
      loadConfig({ DRY_RUN: "false" }),
      {
        listCampaigns: async () => [
          { id: 1, name: "Goliath Displacement M", status: "ACTIVE", client_id: 548611 },
          { id: 9, name: "Pod control shell", status: "PAUSED", client_id: 548611 },
        ],
        listAllEmailAccounts: async () => [
          {
            id: 11,
            from_email: "aaravsanchez@getoutreachdesk.info",
            from_name: "Aarav Sanchez",
            signature: "Aarav Sanchez\nGoliath Cybersecurity",
            client_id: 900001,
            campaign_ids: [1, 9],
          },
        ],
        listClients: async () => [
          { id: 548611, name: "Dave Ackley", logo: "Goliath Cybersecurity" },
          { id: 900001, name: "Generic", logo: "Generic" },
        ],
        ensureTag: async (name: string) => ({ id: 71, name }),
        assignTags: async (ids: number[]) => {
          tagged.push([...ids]);
        },
        addEmailAccountsToCampaign: async () => undefined,
        removeEmailAccountsFromCampaign: async () => undefined,
        updateEmailAccount: async (id: number, fields: Record<string, unknown>) => {
          updates.push({ id, fields });
        },
      } as unknown as SmartleadClient,
      state,
    );

    const result = await service.run({ dryRun: false });
    assert.deepEqual(tagged, [[11]]);
    assert.equal(updates[0]?.fields.client_id, null);
    assert.equal(updates[0]?.fields.signature, undefined);
    assert.equal(result.signaturesSet, 0);
    assert.equal(result.restored.length, 0);
  });

  it("D176: will not restore an attach-blocked generic onto Goliath", async () => {
    const added: Array<[number, number[]]> = [];
    const state = new StateStore(
      `/tmp/one-client-block-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    state.upsertAttachBlock({
      domain: "cleartechco.com",
      emails: ["ada@cleartechco.com"],
      accountIds: [11],
      reason: "sender_blocked",
    });
    const service = serviceWith(
      {
        listCampaigns: async () => [
          { id: 3851730, name: "Goliath MDR", status: "ACTIVE", client_id: 548611 },
          { id: 2, name: "Peterson C3", status: "ACTIVE", client_id: 548610 },
        ],
        listAllEmailAccounts: async () => [
          {
            id: 11,
            from_email: "ada@cleartechco.com",
            from_name: "Ada Clear",
            signature: "Ada Clear\nGoliath Cybersecurity",
            client_id: 548610,
            campaign_ids: [2],
          },
        ],
        listClients: async () => [
          { id: 548611, name: "Dave Ackley", logo: "Goliath Cybersecurity" },
          { id: 548610, name: "Peterson", logo: "Roofs by Peterson" },
        ],
        addEmailAccountsToCampaign: async (campaignId: number, ids: number[]) => {
          added.push([campaignId, [...ids]]);
        },
      },
      state,
    );

    const result = await service.run({ dryRun: false });
    assert.deepEqual(added, []);
    assert.ok(result.skipped.some((row) => row.includes("attach blocked")));
  });

  it("D193: does not restore GENERIC pool senders onto a client campaign", async () => {
    const added: Array<[number, number[]]> = [];
    const removed: Array<[number, number[]]> = [];
    const state = new StateStore(
      `/tmp/one-client-d193-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    state.approveGenericBackfill({
      campaignId: 3847798,
      approvedAt: "2026-09-01T00:00:00Z",
      approvedBy: "josh",
    });
    state.approveGenericBackfill({
      campaignId: 3763803,
      approvedAt: "2026-09-01T00:00:00Z",
      approvedBy: "josh",
    });
    const service = serviceWith(
      {
        listCampaigns: async () => [
          {
            id: 1,
            name: "Goliath Displacement M",
            status: "PAUSED",
            client_id: 548611,
          },
          {
            id: 3847798,
            name: "TechEvo NE IT DM v2 Red Sox",
            status: "ACTIVE",
            client_id: 521881,
          },
          {
            id: 3763803,
            name: "BCP Logistics Under-1k (With Team)",
            status: "ACTIVE",
            client_id: 542838,
          },
        ],
        listAllEmailAccounts: async () => [
          {
            id: 11,
            from_email: "ada@trygetintroduced.info",
            from_name: "Ada Pool",
            signature: "Ada Pool\nGoliath Cybersecurity",
            client_id: 521881,
            tags: [{ tag_name: "GENERIC" }],
            campaign_ids: [3847798],
          },
        ],
        listClients: async () => [
          { id: 548611, name: "Dave Ackley", logo: "Goliath Cybersecurity" },
          { id: 521881, name: "TechEvolution", logo: "TechEvolution" },
          { id: 542838, name: "BCP", logo: "Bolder Cyber Partners" },
        ],
        addEmailAccountsToCampaign: async (campaignId: number, ids: number[]) => {
          added.push([campaignId, [...ids]]);
        },
        removeEmailAccountsFromCampaign: async (
          campaignId: number,
          ids: number[],
        ) => {
          removed.push([campaignId, [...ids]]);
        },
      },
      state,
    );

    const result = await service.run({ dryRun: false });
    assert.deepEqual(
      added,
      [],
      "D193 — leftover D134 approvals must not dump generics onto TechEvo / BCP",
    );
    assert.deepEqual(
      removed,
      [],
      "D197 — exclusive generic on a 1-seat TechEvo lane must not be peeled below 40",
    );
    assert.equal(result.restored.length, 0);
    assert.equal(result.pulled.length, 0);
  });

  it("D197: exclusive generic + client-sig min-40 staff is not peeled or rewritten", async () => {
    const removed: Array<[number, number[]]> = [];
    const added: Array<[number, number[]]> = [];
    const updates: Array<{ id: number; fields: Record<string, unknown> }> = [];
    const named = Array.from({ length: 24 }, (_, i) => ({
      id: 200 + i,
      from_email: `parlay-${i}@parlay.test`,
      client_id: 77,
      campaign_ids: [10],
    }));
    const generics = Array.from({ length: 16 }, (_, i) => ({
      id: 300 + i,
      from_email: `spare-${i}@trygetintroduced.info`,
      from_name: "Ada Pool",
      signature: "Ada Pool\nParlay",
      client_id: 77,
      tags: [{ tag_name: "GENERIC" }],
      campaign_ids: [10],
    }));
    const service = serviceWith({
      listCampaigns: async () => [
        {
          id: 1,
          name: "Goliath Displacement M",
          status: "PAUSED",
          client_id: 548611,
        },
        { id: 10, name: "Parlay Sports", status: "ACTIVE", client_id: 77 },
      ],
      listAllEmailAccounts: async () => [...named, ...generics],
      listClients: async () => [
        { id: 548611, name: "Dave Ackley", logo: "Goliath Cybersecurity" },
        { id: 77, name: "Parlay", logo: "Parlay" },
      ],
      addEmailAccountsToCampaign: async (campaignId: number, ids: number[]) => {
        added.push([campaignId, [...ids]]);
      },
      removeEmailAccountsFromCampaign: async (
        campaignId: number,
        ids: number[],
      ) => {
        removed.push([campaignId, [...ids]]);
      },
      updateEmailAccount: async (id: number, fields: Record<string, unknown>) => {
        updates.push({ id, fields });
      },
    });

    const result = await service.run({ dryRun: false });
    assert.deepEqual(removed, []);
    assert.deepEqual(added, []);
    assert.equal(result.pulled.length, 0);
    assert.equal(result.restored.length, 0);
    assert.equal(result.signaturesSet, 0);
    assert.deepEqual(updates, []);
  });

  it("D198: dedicated generic on Parlay / TechEvo is not peeled even above 40", async () => {
    const removed: Array<[number, number[]]> = [];
    const added: Array<[number, number[]]> = [];
    const updates: Array<{ id: number; fields: Record<string, unknown> }> = [];
    const service = serviceWith({
      listCampaigns: async () => [
        {
          id: 1,
          name: "Goliath Displacement M",
          status: "PAUSED",
          client_id: 548611,
        },
        {
          id: 3847798,
          name: "TechEvo NE IT DM v2 Red Sox",
          status: "ACTIVE",
          client_id: 521881,
        },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 11,
          from_email: "ada@trygetintroduced.info",
          from_name: "Ada Pool",
          signature: "Ada Pool\nTechEvolution",
          client_id: 521881,
          tags: [{ tag_name: "GENERIC" }],
          campaign_ids: [3847798],
        },
        ...padAccounts(3847798, 521881),
      ],
      listClients: async () => [
        { id: 548611, name: "Dave Ackley", logo: "Goliath Cybersecurity" },
        { id: 521881, name: "TechEvolution", logo: "TechEvolution" },
      ],
      addEmailAccountsToCampaign: async (campaignId: number, ids: number[]) => {
        added.push([campaignId, [...ids]]);
      },
      removeEmailAccountsFromCampaign: async (
        campaignId: number,
        ids: number[],
      ) => {
        removed.push([campaignId, [...ids]]);
      },
      updateEmailAccount: async (id: number, fields: Record<string, unknown>) => {
        updates.push({ id, fields });
      },
    });

    const result = await service.run({ dryRun: false });
    assert.deepEqual(removed, []);
    assert.deepEqual(added, []);
    assert.equal(result.pulled.length, 0);
    assert.equal(result.restored.length, 0);
    assert.deepEqual(updates, []);
  });

  it("D198: a dedicated generic linked to two named clients still peels the foreign camp", async () => {
    const removed: Array<[number, number[]]> = [];
    const service = serviceWith({
      listCampaigns: async () => [
        { id: 10, name: "Parlay Sports", status: "ACTIVE", client_id: 77 },
        {
          id: 3847798,
          name: "TechEvo NE IT DM v2 Red Sox",
          status: "ACTIVE",
          client_id: 521881,
        },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 11,
          from_email: "ada@trygetintroduced.info",
          from_name: "Ada Pool",
          signature: "Ada Pool\nParlay",
          client_id: 77,
          tags: [{ tag_name: "GENERIC" }],
          campaign_ids: [10, 3847798],
        },
        ...padAccounts(10, 77),
        ...padAccounts(3847798, 521881, 40, 900),
      ],
      listClients: async () => [
        { id: 548611, name: "Dave Ackley", logo: "Goliath Cybersecurity" },
        { id: 77, name: "Parlay", logo: "Parlay" },
        { id: 521881, name: "TechEvolution", logo: "TechEvolution" },
      ],
      removeEmailAccountsFromCampaign: async (
        campaignId: number,
        ids: number[],
      ) => {
        removed.push([campaignId, [...ids]]);
      },
    });

    const result = await service.run({ dryRun: false });
    assert.deepEqual(removed, [[3847798, [11]]]);
    assert.equal(result.pulled[0]?.email, "ada@trygetintroduced.info");
    assert.equal(result.restored.length, 0);
  });

  it("D76: surplus undedicated rotating generics above 40 may still be pulled", async () => {
    const removed: Array<[number, number[]]> = [];
    const service = serviceWith({
      listCampaigns: async () => [
        {
          id: 3847798,
          name: "TechEvo NE IT DM v2 Red Sox",
          status: "ACTIVE",
          client_id: 521881,
        },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 11,
          from_email: "ada@trygetintroduced.info",
          from_name: "Ada Pool",
          signature: "Ada Pool\nGoliath Cybersecurity",
          client_id: null,
          tags: [{ tag_name: "GENERIC" }],
          campaign_ids: [3847798],
        },
        ...padAccounts(3847798, 521881),
      ],
      listClients: async () => [
        { id: 548611, name: "Dave Ackley", logo: "Goliath Cybersecurity" },
        { id: 521881, name: "TechEvolution", logo: "TechEvolution" },
      ],
      removeEmailAccountsFromCampaign: async (
        campaignId: number,
        ids: number[],
      ) => {
        removed.push([campaignId, [...ids]]);
      },
    });

    const result = await service.run({ dryRun: false });
    assert.deepEqual(removed, [[3847798, [11]]]);
    assert.equal(result.pulled[0]?.email, "ada@trygetintroduced.info");
  });

  it("D199: exclusive + client-sig restaff is not peeled as Goliath even without client_id", async () => {
    const removed: Array<[number, number[]]> = [];
    const added: Array<[number, number[]]> = [];
    const service = serviceWith({
      listCampaigns: async () => [
        {
          id: 1,
          name: "Goliath Displacement M",
          status: "PAUSED",
          client_id: 548611,
        },
        {
          id: 3847798,
          name: "TechEvo NE IT DM v2 Red Sox",
          status: "ACTIVE",
          client_id: 521881,
        },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 11,
          from_email: "ada@trygetintroduced.info",
          from_name: "Ada Pool",
          signature: "Ada Pool\nTechEvolution",
          client_id: null,
          tags: [{ tag_name: "GENERIC" }],
          is_smtp_success: true,
          is_imap_success: true,
          campaign_ids: [3847798],
        },
        ...padAccounts(3847798, 521881),
      ],
      listClients: async () => [
        { id: 548611, name: "Dave Ackley", logo: "Goliath Cybersecurity" },
        { id: 521881, name: "TechEvolution", logo: "TechEvolution" },
      ],
      addEmailAccountsToCampaign: async (campaignId: number, ids: number[]) => {
        added.push([campaignId, [...ids]]);
      },
      removeEmailAccountsFromCampaign: async (
        campaignId: number,
        ids: number[],
      ) => {
        removed.push([campaignId, [...ids]]);
      },
    });

    const result = await service.run({ dryRun: false });
    assert.deepEqual(removed, []);
    assert.deepEqual(added, []);
    assert.equal(result.pulled.length, 0);
  });

  it("D199: 40 staffable exclusives + disconnected leftovers must not peel below 40", async () => {
    const removed: number[] = [];
    const exclusives = Array.from({ length: 40 }, (_, i) => ({
      id: 300 + i,
      from_email: `spare-${i}@trygetintroduced.info`,
      from_name: "Ada Pool",
      signature: "Ada Pool\nGoliath Cybersecurity",
      client_id: null,
      tags: [{ tag_name: "GENERIC" }],
      is_smtp_success: true,
      is_imap_success: true,
      campaign_ids: [3847798],
    }));
    const zombies = Array.from({ length: 32 }, (_, i) => ({
      id: 400 + i,
      from_email: `dead-${i}@techevo.test`,
      client_id: 521881,
      is_smtp_success: false,
      campaign_ids: [3847798],
    }));
    const service = serviceWith({
      listCampaigns: async () => [
        {
          id: 3847798,
          name: "TechEvo NE IT DM v2 Red Sox",
          status: "ACTIVE",
          client_id: 521881,
        },
      ],
      listAllEmailAccounts: async () => [...exclusives, ...zombies],
      listClients: async () => [
        { id: 548611, name: "Dave Ackley", logo: "Goliath Cybersecurity" },
        { id: 521881, name: "TechEvolution", logo: "TechEvolution" },
      ],
      removeEmailAccountsFromCampaign: async (
        _campaignId: number,
        ids: number[],
      ) => {
        removed.push(...ids);
      },
    });

    const result = await service.run({ dryRun: false });
    const peeledLive = removed.filter((id) => id >= 300 && id < 400);
    assert.deepEqual(
      peeledLive,
      [],
      "D199 — peeling live exclusives because 32 disconnected inflated raw membership is the Sep 21 hole",
    );
    assert.equal(result.pulled.length, 0);
  });

  it("D184: does not rewrite an exclusive Insight mailbox to SalesGlider", async () => {
    const updates: Array<{ id: number; fields: Record<string, unknown> }> = [];
    const service = serviceWith({
      listCampaigns: async () => [
        {
          id: 3921647,
          name: "Insight Consolidation Gateway SEG",
          status: "ACTIVE",
          client_id: 345263,
        },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 68,
          from_email: "joshua@salesglidertop.org",
          from_name: "Joshua Osborn",
          signature: "Joshua Osborn\nRoofs by Peterson",
          client_id: 345263,
          campaign_ids: [3921647],
        },
      ],
      listClients: async () => [
        { id: 345263, name: "SalesGlider", logo: "SalesGlider" },
        { id: 99, name: "Peterson", logo: "Roofs by Peterson" },
      ],
      updateEmailAccount: async (id: number, fields: Record<string, unknown>) => {
        updates.push({ id, fields });
      },
    });

    const result = await service.run({ dryRun: false });
    assert.equal(result.signaturesSet, 0);
    assert.deepEqual(updates, []);
  });
});
