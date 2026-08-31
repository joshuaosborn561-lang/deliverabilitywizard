import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import type { SmartDeliveryClient } from "../clients/smartdelivery.js";
import { StateStore } from "../state/store.js";
import { ClientDayBriefService } from "./clientDayBrief.js";

describe("client day brief drafts (D89)", () => {
  it("EOD lists DRAFTED campaigns that still have remaining leads", async () => {
    const state = new StateStore(
      `/tmp/dw-day-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    const briefs: Array<{ loadedDrafts?: Array<{ id: number }> }> = [];
    const service = new ClientDayBriefService(
      loadConfig({}),
      {
        listCampaigns: async () => [
          { id: 1, name: "Live send", status: "ACTIVE", client_id: 9 },
          { id: 2, name: "Parlay3 Launch", status: "DRAFTED", client_id: 9 },
          { id: 3, name: "Empty draft", status: "DRAFT", client_id: 9 },
          { id: 4, name: "Pod control shell", status: "DRAFTED" },
        ],
        listClients: async () => [{ id: 9, name: "Parlay" }],
        getCampaignAnalyticsByDate: async () => ({
          sent_count: 10,
          bounce_count: 0,
        }),
        getCampaignStatistics: async (id: number) => {
          if (id === 2) return { total_leads: 2500, contacted: 100 };
          if (id === 3) return { total_leads: 10, contacted: 10 };
          return { total_leads: 0 };
        },
        getCampaign: async () => null,
        listAllEmailAccounts: async () => [],
      } as unknown as SmartleadClient,
      { listTests: async () => [] } as unknown as SmartDeliveryClient,
      {
        notifyClientDayBrief: async (summary: {
          loadedDrafts?: Array<{ id: number }>;
        }) => {
          briefs.push(summary);
        },
      } as unknown as SlackClient,
      state,
    );

    const result = await service.run();
    assert.deepEqual(
      result.loadedDrafts?.map((row) => row.id),
      [2],
    );
    assert.equal(result.loadedDrafts?.[0]?.remaining, 2400);
    assert.deepEqual(briefs[0]?.loadedDrafts?.map((row) => row.id), [2]);
  });

  it("10:00 / 13:00 slots include drafts the same as 16:30 (D156)", async () => {
    const state = new StateStore(
      `/tmp/dw-day-mid-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    const briefs: Array<{ loadedDrafts?: Array<{ id: number }> }> = [];
    const service = new ClientDayBriefService(
      loadConfig({}),
      {
        listCampaigns: async () => [
          { id: 2, name: "Parlay3 Launch", status: "DRAFTED", client_id: 9 },
        ],
        listClients: async () => [],
        getCampaignAnalyticsByDate: async () => ({
          sent_count: 0,
          bounce_count: 0,
        }),
        getCampaignStatistics: async () => {
          return { total_leads: 100, contacted: 0 };
        },
        getCampaign: async () => null,
        listAllEmailAccounts: async () => [],
      } as unknown as SmartleadClient,
      { listTests: async () => [] } as unknown as SmartDeliveryClient,
      {
        notifyClientDayBrief: async (summary: {
          loadedDrafts?: Array<{ id: number }>;
        }) => {
          briefs.push(summary);
        },
      } as unknown as SlackClient,
      state,
    );

    const result = await service.run();
    assert.deepEqual(result.loadedDrafts?.map((row) => row.id), [2]);
    assert.deepEqual(briefs[0]?.loadedDrafts?.map((row) => row.id), [2]);
  });
});
