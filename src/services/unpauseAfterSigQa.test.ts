import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import type { SmartDeliveryClient } from "../clients/smartdelivery.js";
import type { StateStore } from "../state/store.js";
import { UnpauseAfterSigQaService } from "./unpauseAfterSigQa.js";

function fakeState(bouncePaused: number[] = []): StateStore {
  const stamped = new Set(bouncePaused.map(String));
  return {
    isBouncePaused: (id: number) => stamped.has(String(id)),
  } as unknown as StateStore;
}

function deliveryWith(
  tests: Array<Record<string, unknown>>,
): SmartDeliveryClient {
  return {
    listTests: async () => tests,
  } as unknown as SmartDeliveryClient;
}

const passingTest = (campaignId: number) => ({
  spam_test_id: 900 + campaignId,
  test_name: `Auto: campaign ${campaignId}`,
  status: "COMPLETED",
  created_at: "2026-08-26T00:00:00Z",
  campaign_id: campaignId,
  inbox_count: 9,
  tab_count: 0,
  spam_count: 1,
});

describe("UnpauseAfterSigQaService", () => {
  it("starts a paused Goliath campaign when senders match and the bar is met (D77/D106)", async () => {
    const statuses: Array<[number, string]> = [];
    const service = new UnpauseAfterSigQaService(
      loadConfig({ DRY_RUN: "false" }),
      {
        listCampaigns: async () => [
          { id: 1, name: "Goliath Displacement M", status: "PAUSED", client_id: 548611 },
          { id: 8, name: "Goliath L1 AirPods", status: "STOPPED", client_id: 548611 },
          { id: 9, name: "Pod control shell", status: "PAUSED", client_id: 548611 },
        ],
        listAllEmailAccounts: async () => [
          {
            id: 11,
            from_email: "aaravsanchez@getoutreachdesk.info",
            from_name: "Aarav Sanchez",
            signature: "Aarav Sanchez\nGoliath Cybersecurity",
            client_id: 548611,
            campaign_ids: [1],
          },
        ],
        listClients: async () => [
          { id: 548611, name: "Dave Ackley", logo: "Goliath Cybersecurity" },
          { id: 99, name: "Peterson", logo: "Roofs by Peterson" },
        ],
        updateCampaignStatus: async (id: number, status: string) => {
          statuses.push([id, status]);
        },
      } as unknown as SmartleadClient,
      deliveryWith([passingTest(1)]),
      fakeState(),
    );

    const result = await service.run({ dryRun: false });
    assert.deepEqual(statuses, [[1, "START"]]);
    assert.equal(result.started[0]?.campaignId, 1);
    assert.ok(result.blocked.some((row) => row.includes("shell")));
  });

  it("does not start a paused non-POC campaign even when signatures match (D82)", async () => {
    const statuses: Array<[number, string]> = [];
    const service = new UnpauseAfterSigQaService(
      loadConfig({ DRY_RUN: "false" }),
      {
        listCampaigns: async () => [
          { id: 4, name: "Vasco - Service - Nissan", status: "PAUSED", client_id: 20 },
        ],
        listAllEmailAccounts: async () => [
          {
            id: 11,
            from_email: "pat@vasco.com",
            from_name: "Pat",
            signature: "Pat\nVasco Warranty",
            client_id: 20,
            campaign_ids: [4],
          },
        ],
        listClients: async () => [
          { id: 20, name: "Vasco Warranty", logo: "Vasco Warranty" },
        ],
        updateCampaignStatus: async (id: number, status: string) => {
          statuses.push([id, status]);
        },
      } as unknown as SmartleadClient,
      deliveryWith([passingTest(4)]),
      fakeState(),
    );

    const result = await service.run({ dryRun: false });
    assert.deepEqual(statuses, []);
    assert.ok(result.blocked.some((row) => row.includes("not a POC")));
  });

  it("does not start when a leftover Peterson signature is still on the campaign", async () => {
    const statuses: Array<[number, string]> = [];
    const service = new UnpauseAfterSigQaService(
      loadConfig({ DRY_RUN: "false" }),
      {
        listCampaigns: async () => [
          { id: 1, name: "Goliath Displacement M", status: "PAUSED", client_id: 548611 },
        ],
        listAllEmailAccounts: async () => [
          {
            id: 11,
            from_email: "aaravsanchez@getoutreachdesk.info",
            from_name: "Aarav Sanchez",
            signature: "Aarav Sanchez\nRoofs by Peterson",
            campaign_ids: [1],
          },
        ],
        listClients: async () => [
          { id: 548611, name: "Dave Ackley", logo: "Goliath Cybersecurity" },
          { id: 99, name: "Peterson", logo: "Roofs by Peterson" },
        ],
        updateCampaignStatus: async (id: number, status: string) => {
          statuses.push([id, status]);
        },
      } as unknown as SmartleadClient,
      deliveryWith([passingTest(1)]),
      fakeState(),
    );

    const result = await service.run({ dryRun: false });
    assert.deepEqual(statuses, []);
    assert.ok(result.blocked[0]?.includes("sig mismatch"));
  });

  it("D128: never starts a campaign the bounce loop paused", async () => {
    const statuses: Array<[number, string]> = [];
    const service = new UnpauseAfterSigQaService(
      loadConfig({ DRY_RUN: "false" }),
      {
        listCampaigns: async () => [
          { id: 1, name: "Goliath Displacement M", status: "PAUSED", client_id: 548611 },
        ],
        listAllEmailAccounts: async () => [
          {
            id: 11,
            from_email: "aaravsanchez@getoutreachdesk.info",
            from_name: "Aarav Sanchez",
            signature: "Aarav Sanchez\nGoliath Cybersecurity",
            client_id: 548611,
            campaign_ids: [1],
          },
        ],
        listClients: async () => [
          { id: 548611, name: "Dave Ackley", logo: "Goliath Cybersecurity" },
        ],
        updateCampaignStatus: async (id: number, status: string) => {
          statuses.push([id, status]);
        },
      } as unknown as SmartleadClient,
      deliveryWith([passingTest(1)]),
      fakeState([1]),
    );

    const result = await service.run({ dryRun: false });
    assert.deepEqual(statuses, []);
    assert.ok(result.blocked.some((row) => row.includes("bounce loop paused")));
  });

  it("D106: blocks below the 85% bar and when no living reading exists", async () => {
    const statuses: Array<[number, string]> = [];
    const smartlead = {
      listCampaigns: async () => [
        { id: 1, name: "Goliath Displacement M", status: "PAUSED", client_id: 548611 },
        { id: 2, name: "Goliath Displacement L", status: "PAUSED", client_id: 548611 },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 11,
          from_email: "aaravsanchez@getoutreachdesk.info",
          from_name: "Aarav Sanchez",
          signature: "Aarav Sanchez\nGoliath Cybersecurity",
          client_id: 548611,
          campaign_ids: [1, 2],
        },
      ],
      listClients: async () => [
        { id: 548611, name: "Dave Ackley", logo: "Goliath Cybersecurity" },
      ],
      updateCampaignStatus: async (id: number, status: string) => {
        statuses.push([id, status]);
      },
    } as unknown as SmartleadClient;
    const service = new UnpauseAfterSigQaService(
      loadConfig({ DRY_RUN: "false" }),
      smartlead,
      deliveryWith([
        {
          ...passingTest(1),
          inbox_count: 7,
          tab_count: 2,
          spam_count: 1,
        },
      ]),
      fakeState(),
    );

    const result = await service.run({ dryRun: false });
    assert.deepEqual(statuses, [], "70% inbox and no reading both stay down");
    assert.ok(
      result.blocked.some((row) => row.includes("below the 85% launch bar")),
    );
    assert.ok(
      result.blocked.some((row) => row.includes("no living placement reading")),
    );
  });
});
