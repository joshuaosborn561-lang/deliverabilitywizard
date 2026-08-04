import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import type { SmartDeliveryClient } from "../clients/smartdelivery.js";
import type { StateStore } from "../state/store.js";
import type { SmartleadCampaign } from "../types/index.js";
import {
  addDaysIso,
  CampaignScanner,
  OPEN_ENDED_TEST_DAYS,
  scheduleStartTime,
} from "./campaignScanner.js";

describe("scheduleStartTime", () => {
  it("pads forward from now by the given buffer", () => {
    const now = new Date("2026-08-03T09:00:00.000Z");
    const result = scheduleStartTime(2, now);
    assert.equal(result, "2026-08-03T09:02:00.000Z");
  });

  it("defaults to a 2-minute buffer", () => {
    const now = new Date("2026-08-03T09:00:00.000Z");
    const result = scheduleStartTime(undefined, now);
    assert.equal(result, "2026-08-03T09:02:00.000Z");
  });

  it("is always strictly after the moment it was generated, even accounting for request latency", () => {
    const before = Date.now();
    const result = Date.parse(scheduleStartTime());
    // Simulate a slow request: SmartDelivery validates against its own clock
    // some time after we generated the timestamp. A few seconds of latency
    // must not be enough to put our timestamp in the past.
    const serverNowAfterLatency = before + 5_000;
    assert.ok(
      result >= serverNowAfterLatency,
      `expected ${result} to be >= ${serverNowAfterLatency} (now + 5s latency)`,
    );
  });
});

describe("addDaysIso", () => {
  it("adds whole UTC days", () => {
    const result = addDaysIso(new Date("2026-08-03T09:00:00.000Z"), 3);
    assert.equal(result, "2026-08-06T09:00:00.000Z");
  });
});

function campaign(id: number, status: string): SmartleadCampaign {
  return { id, name: `Campaign ${id}`, status };
}

function fakeSlack(): SlackClient {
  return {
    send: async () => undefined,
    notifyRunSummary: async () => undefined,
    notifyQuotaBlocked: async () => undefined,
  } as unknown as SlackClient;
}

function fakeState(): StateStore {
  const testedCampaigns: Record<string, unknown> = {};
  return {
    get: () => ({ lastScanAt: null, testedCampaigns }),
    markCampaignTested: (record: { campaignId: number }) => {
      testedCampaigns[String(record.campaignId)] = record;
    },
    setLastScanAt: () => undefined,
    save: async () => undefined,
  } as unknown as StateStore;
}

describe("CampaignScanner — status re-check before creation", () => {
  it("re-checks status right before creating, skipping a campaign that went inactive since the initial list", async () => {
    const config = loadConfig({});
    let listCampaignsCalls = 0;
    const created: unknown[] = [];

    const smartlead = {
      listCampaigns: async () => {
        listCampaignsCalls += 1;
        // First call (candidate selection): both still ACTIVE.
        // Second call (pre-creation re-check): campaign 2 has since paused.
        return listCampaignsCalls === 1
          ? [campaign(1, "ACTIVE"), campaign(2, "ACTIVE")]
          : [campaign(1, "ACTIVE"), campaign(2, "PAUSED")];
      },
      getCampaignEmailAccounts: async () => [
        { id: 10, from_email: "sender@example.com" },
      ],
      getCampaignSequences: async () => [
        { id: 500, seq_number: 1, subject: "Hi" },
      ],
    } as unknown as SmartleadClient;

    const smartDelivery = {
      assertAccessActive: async () => "ok",
      listTests: async () => [],
      resolveProviderIds: async () => [],
      createAutomatedPlacement: async (input: unknown) => {
        created.push(input);
        return { id: "new-test-id" };
      },
      createManualPlacement: async () => ({ id: "manual-id" }),
    } as unknown as SmartDeliveryClient;

    const scanner = new CampaignScanner(
      config,
      smartlead,
      smartDelivery,
      fakeSlack(),
      fakeState(),
    );

    const result = await scanner.run({ trigger: "manual" });

    assert.equal(result.eligible, 2, "both campaigns looked eligible at candidate-selection time");
    assert.equal(created.length, 1, "only the still-active campaign got a test created");
    assert.equal((created[0] as { campaign_id: number }).campaign_id, 1);
    assert.ok(
      result.skipped >= 1,
      "the campaign that went inactive between list and creation is counted as skipped, not silently dropped",
    );
  });

  it("always sends a test_end_date, even with the default open-ended (0) config", async () => {
    const config = loadConfig({});
    assert.equal(config.placementTestEndDays, 0);
    const created: Array<Record<string, unknown>> = [];

    const smartlead = {
      listCampaigns: async () => [campaign(1, "ACTIVE")],
      getCampaignEmailAccounts: async () => [
        { id: 10, from_email: "sender@example.com" },
      ],
      getCampaignSequences: async () => [
        { id: 500, seq_number: 1, subject: "Hi" },
      ],
    } as unknown as SmartleadClient;

    const smartDelivery = {
      assertAccessActive: async () => "ok",
      listTests: async () => [],
      resolveProviderIds: async () => [],
      createAutomatedPlacement: async (input: Record<string, unknown>) => {
        created.push(input);
        return { id: "new-test-id" };
      },
      createManualPlacement: async () => ({ id: "manual-id" }),
    } as unknown as SmartDeliveryClient;

    const scanner = new CampaignScanner(
      config,
      smartlead,
      smartDelivery,
      fakeSlack(),
      fakeState(),
    );

    await scanner.run({ trigger: "manual" });

    assert.equal(created.length, 1);
    const testEndDate = created[0]!.test_end_date as string;
    assert.ok(testEndDate, "test_end_date must always be present — SmartDelivery requires it");
    const daysOut = (Date.parse(testEndDate) - Date.now()) / 86_400_000;
    assert.ok(
      daysOut > OPEN_ENDED_TEST_DAYS - 1 && daysOut < OPEN_ENDED_TEST_DAYS + 1,
      `expected ~${OPEN_ENDED_TEST_DAYS} days out, got ${daysOut}`,
    );
  });
});
