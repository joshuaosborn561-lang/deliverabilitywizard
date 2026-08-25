import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import { StateStore } from "../state/store.js";
import { OneClientMembershipService } from "./oneClientMembership.js";

function serviceWith(
  smartlead: Partial<SmartleadClient>,
): OneClientMembershipService {
  const state = new StateStore(
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
    state,
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

  it("treats a leftover-tagged pool generic as Goliath and restores it (D76)", async () => {
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
          signature: "Aarav Sanchez\nRoofs by Peterson",
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
    assert.equal(updates[0]?.fields.signature, "Aarav Sanchez\nGoliath Cybersecurity");
    assert.equal(updates[0]?.fields.client_id, 548611);
  });

  it("puts a shell-only leftover-tagged generic back on live Goliath (D76)", async () => {
    const added: Array<[number, number[]]> = [];
    const removed: Array<[number, number[]]> = [];
    const updates: Array<{ id: number; fields: Record<string, unknown> }> = [];
    const service = serviceWith({
      listCampaigns: async () => [
        { id: 1, name: "Goliath Displacement M", status: "ACTIVE", client_id: 548611 },
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
    assert.deepEqual(added, [[1, [11]]]);
    assert.deepEqual(removed, []);
    assert.equal(result.restored[0]?.campaignId, 1);
    assert.equal(updates[0]?.fields.signature, "Aarav Sanchez\nGoliath Cybersecurity");
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
});
