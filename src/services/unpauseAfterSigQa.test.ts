import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import { UnpauseAfterSigQaService } from "./unpauseAfterSigQa.js";

describe("UnpauseAfterSigQaService", () => {
  it("starts a paused Goliath campaign when every sender matches (D77)", async () => {
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
    );

    const result = await service.run({ dryRun: false });
    assert.deepEqual(statuses, []);
    assert.ok(result.blocked[0]?.includes("sig mismatch"));
  });

  it("does not START a bounce-autostop pause even when signatures match (D125)", async () => {
    const statuses: Array<[number, string]> = [];
    const state = {
      getBouncePausedAt: (id: number) => (id === 1 ? "2026-08-26T15:10:00Z" : undefined),
      getBounceSnapshot: () => undefined,
      markBouncePaused: () => undefined,
    };
    const service = new UnpauseAfterSigQaService(
      loadConfig({ DRY_RUN: "false" }),
      {
        listCampaigns: async () => [
          { id: 1, name: "Goliath L4 Education Tickets", status: "PAUSED", client_id: 548611 },
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
      state as never,
    );

    const result = await service.run({ dryRun: false });
    assert.deepEqual(statuses, []);
    assert.ok(result.blocked.some((row) => row.includes("bounce autostop")));
  });

  it("does not START when the bounce snapshot is still over 10% after 1k (D125)", async () => {
    const statuses: Array<[number, string]> = [];
    const marked: number[] = [];
    const state = {
      getBouncePausedAt: () => undefined,
      getBounceSnapshot: (id: number) =>
        id === 1
          ? { bounced: 441, sent: 1413, at: "2026-08-26T15:10:00Z" }
          : undefined,
      markBouncePaused: (id: number) => {
        marked.push(id);
      },
    };
    const service = new UnpauseAfterSigQaService(
      loadConfig({ DRY_RUN: "false" }),
      {
        listCampaigns: async () => [
          { id: 1, name: "Goliath L4 Education Tickets", status: "PAUSED", client_id: 548611 },
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
      state as never,
    );

    const result = await service.run({ dryRun: false });
    assert.deepEqual(statuses, []);
    assert.deepEqual(marked, [1]);
    assert.ok(result.blocked.some((row) => row.includes("still over bounce")));
  });
});
