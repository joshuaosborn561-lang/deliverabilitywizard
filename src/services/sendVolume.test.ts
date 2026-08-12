import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SendVolumeService, businessDate } from "./sendVolume.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";

type Analytics = { sent_count?: number | string };

function harness(options: {
  campaigns: Array<{ id: number; name: string; status: string }>;
  analytics: Record<number, Analytics | Error>;
}) {
  const posted: Array<Record<string, unknown>> = [];
  const smartlead = {
    listCampaigns: async () => options.campaigns,
    getCampaignAnalyticsByDate: async (id: number) => {
      const row = options.analytics[id];
      if (row instanceof Error) throw row;
      return row ?? {};
    },
  } as unknown as SmartleadClient;
  const slack = {
    notifySendVolume: async (summary: Record<string, unknown>) => {
      posted.push(summary);
    },
  } as unknown as SlackClient;
  return { service: new SendVolumeService(smartlead, slack), posted };
}

describe("SendVolumeService", () => {
  it("totals only ACTIVE campaigns and counts how many actually sent", async () => {
    const { service, posted } = harness({
      campaigns: [
        { id: 1, name: "Alpha", status: "ACTIVE" },
        { id: 2, name: "Beta", status: "ACTIVE" },
        { id: 3, name: "Idle", status: "ACTIVE" },
        { id: 4, name: "Old", status: "COMPLETED" },
        { id: 5, name: "Held", status: "PAUSED" },
      ],
      analytics: {
        1: { sent_count: 500 },
        2: { sent_count: 250 },
        3: { sent_count: 0 },
        4: { sent_count: 9999 },
        5: { sent_count: 8888 },
      },
    });

    const result = await service.run();

    assert.equal(result.activeCampaigns, 3);
    assert.equal(result.sendingCampaigns, 2);
    // COMPLETED and PAUSED volume must not leak into the fleet total.
    assert.equal(result.totalSent, 750);
    assert.equal(posted.length, 1);
  });

  it("reads Smartlead's numeric strings as numbers", async () => {
    const { service } = harness({
      campaigns: [{ id: 1, name: "Alpha", status: "ACTIVE" }],
      analytics: { 1: { sent_count: "1200" } },
    });

    const result = await service.run();
    assert.equal(result.totalSent, 1200);
  });

  it("treats a missing or unparseable count as zero rather than NaN", async () => {
    const { service } = harness({
      campaigns: [
        { id: 1, name: "Alpha", status: "ACTIVE" },
        { id: 2, name: "Beta", status: "ACTIVE" },
      ],
      analytics: { 1: {}, 2: { sent_count: "n/a" } },
    });

    const result = await service.run();
    assert.equal(result.totalSent, 0);
    assert.equal(result.sendingCampaigns, 0);
  });

  it("keeps going when one campaign's analytics call fails", async () => {
    const { service } = harness({
      campaigns: [
        { id: 1, name: "Alpha", status: "ACTIVE" },
        { id: 2, name: "Broken", status: "ACTIVE" },
        { id: 3, name: "Gamma", status: "ACTIVE" },
      ],
      analytics: {
        1: { sent_count: 100 },
        2: new Error("429 rate limited"),
        3: { sent_count: 50 },
      },
    });

    const result = await service.run();

    assert.equal(result.totalSent, 150);
    assert.equal(result.errors.length, 1);
    // A campaign we could not read is not silently counted as a zero sender.
    assert.equal(result.sendingCampaigns, 2);
    assert.equal(result.activeCampaigns, 3);
  });

  it("can compute without posting to Slack", async () => {
    const { service, posted } = harness({
      campaigns: [{ id: 1, name: "Alpha", status: "ACTIVE" }],
      analytics: { 1: { sent_count: 10 } },
    });

    await service.run({ alert: false });
    assert.equal(posted.length, 0);
  });
});

describe("businessDate", () => {
  it("uses the New York day, not the UTC day, late in the evening", () => {
    // 01:30 UTC on the 13th is still 21:30 on the 12th in New York.
    assert.equal(businessDate(new Date("2026-08-13T01:30:00Z")), "2026-08-12");
  });

  it("agrees with UTC during the working day", () => {
    assert.equal(businessDate(new Date("2026-08-12T15:00:00Z")), "2026-08-12");
  });
});
