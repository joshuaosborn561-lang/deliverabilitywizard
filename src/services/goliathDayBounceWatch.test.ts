import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.js";
import { GoliathDayBounceWatchService } from "./goliathDayBounceWatch.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import type { SmartDeliveryClient } from "../clients/smartdelivery.js";
import type { SlackClient } from "../clients/slack.js";
import type { StateStore } from "../state/store.js";

describe("GoliathDayBounceWatchService", () => {
  it("pauses and alerts when Chicago-day bounce exceeds 7%", async () => {
    const paused: number[] = [];
    const slackMessages: string[] = [];
    const alerts = new Set<string>();

    const smartlead = {
      listCampaigns: async () => [
        {
          id: 3781909,
          name: "Goliath L1 Financial Services AirPods",
          status: "ACTIVE",
          client_id: 548611,
        },
        {
          id: 3781908,
          name: "Goliath L1 Financial Services Tickets",
          status: "ACTIVE",
          client_id: 548611,
        },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 1,
          from_email: "hot@cleartechco.com",
          campaign_ids: [3781909],
        },
      ],
      getCampaignAnalyticsByDate: async (id: number) => {
        if (id === 3781909) {
          return { sent_count: "200", bounce_count: "40" }; // 20%
        }
        return { sent_count: "200", bounce_count: "8" }; // 4%
      },
      getCampaignStatistics: async () => ({
        total_stats: "40",
        data: Array.from({ length: 40 }, () => ({
          lead_category: "Sender Originated Bounce",
          is_bounced: true,
        })),
      }),
      getCampaignSequences: async () => [
        {
          id: 1,
          seq_number: 1,
          subject: "small thank you",
          email_body: "<p>Got a pair of AirPods on me</p>",
        },
      ],
      getMailboxHealthMetrics: async () => ({
        data: [
          {
            email: "hot@cleartechco.com",
            sent_count: 100,
            bounce_count: 20,
            bounce_rate: 20,
          },
        ],
      }),
      updateCampaignStatus: async (id: number, status: string) => {
        if (status === "PAUSED") paused.push(id);
        return { ok: true };
      },
    } as unknown as SmartleadClient;

    const smartDelivery = {
      listTests: async () => [],
      enrichCampaignIds: async (x: unknown) => x,
    } as unknown as SmartDeliveryClient;

    const slack = {
      send: async (msg: string) => {
        slackMessages.push(msg);
      },
    } as unknown as SlackClient;

    const state = {
      hasAlert: (k: string) => alerts.has(k),
      markAlert: (k: string) => {
        alerts.add(k);
      },
      save: async () => undefined,
      get: () => ({}),
    } as unknown as StateStore;

    const config = loadConfig({
      ENABLE_GOLIATH_DAY_BOUNCE_WATCH: "true",
      GOLIATH_BOUNCE_WATCH_THRESHOLD: "7",
      GOLIATH_BOUNCE_WATCH_MIN_SENT: "50",
      GOLIATH_BOUNCE_WATCH_DATE: "2026-08-13",
      CAYDEN_SLACK_USER_ID: "UCAYDEN",
      DRY_RUN: "false",
    } as NodeJS.ProcessEnv);

    const result = await new GoliathDayBounceWatchService(
      config,
      smartlead,
      smartDelivery,
      slack,
      state,
    ).run();

    assert.equal(result.trips.length, 1);
    assert.equal(result.trips[0]?.campaignId, 3781909);
    assert.equal(result.trips[0]?.paused, true);
    assert.deepEqual(paused, [3781909]);
    assert.ok(slackMessages.some((m) => /<@UCAYDEN>/.test(m)));
    assert.ok(slackMessages.some((m) => /20\.0%/.test(m)));
    // Second run dedupes
    const again = await new GoliathDayBounceWatchService(
      config,
      smartlead,
      smartDelivery,
      slack,
      state,
    ).run();
    assert.equal(again.trips.length, 0);
    assert.equal(again.alreadyAlerted, 1);
  });
});
