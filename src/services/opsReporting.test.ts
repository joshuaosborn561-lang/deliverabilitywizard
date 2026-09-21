import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SmartDeliveryClient } from "../clients/smartdelivery.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import { StateStore } from "../state/store.js";
import type { InventoryBook } from "./inventory.js";
import {
  FleetSummaryService,
  PlacementResultsService,
  titleHasCanaryCopyPhrase,
  OPS_PLACEMENT_REPORT_CAP,
} from "./opsReporting.js";

describe("titleHasCanaryCopyPhrase", () => {
  it("matches the canary copy phrase in a test or campaign title", () => {
    assert.equal(
      titleHasCanaryCopyPhrase("Canary copy: #3815448 Goliath"),
      true,
    );
    assert.equal(titleHasCanaryCopyPhrase("Auto: Campaign Seven"), false);
  });
});

/** D132 — a test book reading the same fake client, one attempt, clients optional. */
function bookOf(sl: unknown): InventoryBook {
  const client = sl as {
    listCampaigns?: () => Promise<unknown[]>;
    listAllEmailAccounts?: (o?: unknown) => Promise<unknown[]>;
    listClients?: () => Promise<unknown[]>;
  };
  return {
    get: async () => ({
      campaigns:
        typeof client.listCampaigns === "function"
          ? await client.listCampaigns()
          : [],
      accounts:
        typeof client.listAllEmailAccounts === "function"
          ? await client.listAllEmailAccounts({ fetchCampaigns: true })
          : [],
      clients:
        typeof client.listClients === "function"
          ? await client.listClients().catch(() => [])
          : [],
      fetchedAt: Date.now(),
    }),
  } as unknown as InventoryBook;
}

async function stateFixture() {
  const state = new StateStore(
    `/tmp/ops-reporting-${process.pid}-${Date.now()}-${Math.random()}.json`,
  );
  await state.load();
  state.markCampaignTested({
    campaignId: 7,
    campaignName: "Campaign Seven",
    testedAt: new Date().toISOString(),
    testIds: ["101"],
    mailboxCount: 5,
    testsCreated: 1,
  });
  return state;
}

describe("PlacementResultsService", () => {
  it("normalizes latest test and provider placement into sortable rows", async () => {
    const state = await stateFixture();
    const smartDelivery = {
      listTests: async () => [
        {
          spam_test_id: 100,
          test_name: "Older",
          status: "COMPLETED",
          created_at: "2026-07-01T00:00:00Z",
          inbox_count: 3,
          spam_count: 1,
          adjusted_total_email_count: 4,
        },
        {
          spam_test_id: 101,
          test_name: "Latest",
          status: "COMPLETED",
          created_at: "2026-08-01T00:00:00Z",
          campaign_id: 7,
          inbox_count: 7,
          tab_count: 1,
          spam_count: 2,
          adjusted_total_email_count: 10,
        },
      ],
      getProviderwiseReport: async (id: number | string) => ({
        status: "COMPLETED",
        result:
          String(id) === "101"
            ? [
                {
                  provider_name: "G Suite",
                  inbox_count: 3,
                  spam_count: 1,
                  adjusted_total_email_count: 4,
                },
                {
                  provider_name: "Office365",
                  inbox_count: 5,
                  spam_count: 0,
                  adjusted_total_email_count: 5,
                },
              ]
            : [],
      }),
    } as unknown as SmartDeliveryClient;
    const smartlead = {
      listCampaigns: async () => [
        { id: 7, name: "Campaign Seven", status: "ACTIVE" },
      ],
    } as unknown as SmartleadClient;
    const service = new PlacementResultsService(
      smartDelivery,
      bookOf(smartlead),
      state,
      1_000,
    );
    const result = await service.get();

    assert.equal(result.rows[0]?.id, "101");
    assert.equal(result.rows[0]?.campaignName, "Campaign Seven");
    assert.equal(result.rows[0]?.inboxPercent, 70);
    assert.equal(result.rows[0]?.googleInboxPercent, 75);
    assert.equal(result.rows[0]?.microsoftInboxPercent, 100);
    assert.equal(result.rows[0]?.spamPercent, 20);
  });

  it("D126: hides canary copy tests and non-active campaigns", async () => {
    const state = await stateFixture();
    const requested: string[] = [];
    const smartDelivery = {
      listTests: async () => [
        {
          spam_test_id: 201,
          test_name: "Canary copy: #7 Campaign Seven",
          status: "COMPLETED",
          created_at: "2026-08-26T12:00:00Z",
          campaign_id: 7,
          inbox_count: 9,
          spam_count: 1,
          adjusted_total_email_count: 10,
        },
        {
          spam_test_id: 202,
          test_name: "Auto: Canary copy campaign",
          status: "COMPLETED",
          created_at: "2026-08-26T11:00:00Z",
          campaign_id: 8,
          inbox_count: 8,
          spam_count: 0,
          adjusted_total_email_count: 8,
        },
        {
          spam_test_id: 203,
          test_name: "Auto: Paused live",
          status: "COMPLETED",
          created_at: "2026-08-26T10:00:00Z",
          campaign_id: 9,
          inbox_count: 7,
          spam_count: 0,
          adjusted_total_email_count: 7,
        },
        {
          spam_test_id: 101,
          test_name: "Auto: Campaign Seven",
          status: "COMPLETED",
          created_at: "2026-08-01T00:00:00Z",
          campaign_id: 7,
          inbox_count: 7,
          tab_count: 1,
          spam_count: 2,
          adjusted_total_email_count: 10,
        },
      ],
      getProviderwiseReport: async (id: number | string) => {
        requested.push(String(id));
        return { status: "COMPLETED", result: [] };
      },
    } as unknown as SmartDeliveryClient;
    const smartlead = {
      listCampaigns: async () => [
        { id: 7, name: "Campaign Seven", status: "ACTIVE" },
        { id: 8, name: "Canary copy: leftover", status: "ACTIVE" },
        { id: 9, name: "Paused live", status: "PAUSED" },
      ],
    } as unknown as SmartleadClient;
    const service = new PlacementResultsService(
      smartDelivery,
      bookOf(smartlead),
      state,
      1_000,
    );
    const result = await service.get();
    assert.deepEqual(
      result.rows.map((row) => row.id),
      ["101"],
    );
    assert.deepEqual(requested, ["101"]);
    assert.equal(result.rows[0]?.campaignName, "Campaign Seven");
  });

  it("D187: returns 80 live tests when more than 80 ACTIVE campaigns have tests", async () => {
    const state = await stateFixture();
    const listed = [];
    const campaigns = [];
    for (let i = 1; i <= 81; i += 1) {
      const campaignId = 1000 + i;
      listed.push({
        spam_test_id: 2000 + i,
        test_name: `Auto: Campaign ${i}`,
        status: "COMPLETED",
        created_at: new Date(Date.UTC(2026, 8, 1, 0, 0, i)).toISOString(),
        campaign_id: campaignId,
        inbox_count: 8,
        spam_count: 2,
        adjusted_total_email_count: 10,
      });
      campaigns.push({
        id: campaignId,
        name: `Campaign ${i}`,
        status: "ACTIVE",
      });
      state.markCampaignTested({
        campaignId,
        campaignName: `Campaign ${i}`,
        testedAt: new Date().toISOString(),
        testIds: [String(2000 + i)],
        mailboxCount: 3,
        testsCreated: 1,
      });
    }
    let providerCalls = 0;
    const smartDelivery = {
      listTests: async () => listed,
      getProviderwiseReport: async () => {
        providerCalls += 1;
        return { result: [] };
      },
    } as unknown as SmartDeliveryClient;
    const smartlead = {
      listCampaigns: async () => campaigns,
    } as unknown as SmartleadClient;
    const service = new PlacementResultsService(
      smartDelivery,
      bookOf(smartlead),
      state,
      1,
    );
    const result = await service.get();
    assert.equal(OPS_PLACEMENT_REPORT_CAP, 80);
    assert.equal(result.rows.length, 80);
    assert.equal(providerCalls, 80);
  });

  it("serves a fresh snapshot on tab-open without calling SmartDelivery", async () => {
    const state = await stateFixture();
    state.setPlacementResults({
      generatedAt: new Date().toISOString(),
      complete: true,
      rows: [
        {
          id: "101",
          name: "Auto: Campaign Seven",
          campaignId: 7,
          campaignName: "Campaign Seven",
          status: "COMPLETED",
          inboxPercent: 70,
          spamPercent: 20,
          googleInboxPercent: 75,
          microsoftInboxPercent: 100,
          totalSeeds: 10,
          providers: [],
        },
      ],
    });
    let listCalls = 0;
    const smartDelivery = {
      listTests: async () => {
        listCalls += 1;
        throw new Error("Rate limit exceeded");
      },
      getProviderwiseReport: async () => {
        throw new Error("should not fetch providers for a fresh snapshot");
      },
    } as unknown as SmartDeliveryClient;
    const smartlead = {
      listCampaigns: async () => [
        { id: 7, name: "Campaign Seven", status: "ACTIVE" },
      ],
    } as unknown as SmartleadClient;
    const service = new PlacementResultsService(
      smartDelivery,
      bookOf(smartlead),
      state,
      60_000,
    );
    const result = await service.get();
    assert.equal(listCalls, 0);
    assert.equal(result.rows[0]?.id, "101");
    assert.equal(result.stale, undefined);
    assert.deepEqual(result.errors, []);
  });

  it("returns the last snapshot instead of throwing when SmartDelivery 429s", async () => {
    const state = await stateFixture();
    state.setPlacementResults({
      generatedAt: "2026-09-09T12:00:00.000Z",
      rows: [
        {
          id: "101",
          name: "Auto: Campaign Seven",
          campaignId: 7,
          campaignName: "Campaign Seven",
          status: "COMPLETED",
          inboxPercent: 70,
          spamPercent: 20,
          googleInboxPercent: 75,
          microsoftInboxPercent: 100,
          totalSeeds: 10,
          providers: [],
        },
      ],
    });
    let listCalls = 0;
    const smartDelivery = {
      listTests: async () => {
        listCalls += 1;
        throw new Error("Rate limit exceeded");
      },
      getProviderwiseReport: async () => {
        throw new Error("should not fetch providers after listTests 429");
      },
    } as unknown as SmartDeliveryClient;
    const smartlead = {
      listCampaigns: async () => [
        { id: 7, name: "Campaign Seven", status: "ACTIVE" },
      ],
    } as unknown as SmartleadClient;
    const service = new PlacementResultsService(
      smartDelivery,
      bookOf(smartlead),
      state,
      1,
      60_000,
    );
    const opened = await service.get();
    assert.equal(opened.stale, true);
    assert.equal(opened.rows[0]?.id, "101");
    assert.equal(opened.rows[0]?.inboxPercent, 70);
    assert.deepEqual(
      opened.errors,
      [],
      "tab-open keeps the snapshot without a red rate-limit banner",
    );

    const refreshed = await service.get(true);
    assert.equal(refreshed.stale, true);
    assert.equal(refreshed.rows[0]?.id, "101");
    assert.match(refreshed.errors.join(" "), /SmartDelivery rate-limited/i);
    assert.equal(listCalls, 1, "cooldown skips a second SmartDelivery poke");
  });

  it("still 200s with a human error when there is no snapshot to fall back to", async () => {
    const state = await stateFixture();
    const smartDelivery = {
      listTests: async () => {
        throw new Error("Rate limit exceeded");
      },
      getProviderwiseReport: async () => ({ result: [] }),
    } as unknown as SmartDeliveryClient;
    const smartlead = {
      listCampaigns: async () => [
        { id: 7, name: "Campaign Seven", status: "ACTIVE" },
      ],
    } as unknown as SmartleadClient;
    const service = new PlacementResultsService(
      smartDelivery,
      bookOf(smartlead),
      state,
      1,
    );
    const result = await service.get();
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0]?.campaignName, "Campaign Seven");
    assert.equal(result.stale, true);
    assert.deepEqual(
      result.errors,
      [],
      "tab-open still shows the known live test without a red banner",
    );
  });

  it("stops further providerwise pulls after a rate limit", async () => {
    const state = await stateFixture();
    state.markCampaignTested({
      campaignId: 8,
      campaignName: "Campaign Eight",
      testedAt: new Date().toISOString(),
      testIds: ["102"],
      mailboxCount: 5,
      testsCreated: 1,
    });
    const requested: string[] = [];
    const smartDelivery = {
      listTests: async () => [
        {
          spam_test_id: 101,
          test_name: "Auto: Campaign Seven",
          status: "COMPLETED",
          created_at: "2026-08-02T00:00:00Z",
          campaign_id: 7,
          inbox_count: 7,
          spam_count: 2,
          adjusted_total_email_count: 10,
        },
        {
          spam_test_id: 102,
          test_name: "Auto: Campaign Eight",
          status: "COMPLETED",
          created_at: "2026-08-01T00:00:00Z",
          campaign_id: 8,
          inbox_count: 8,
          spam_count: 1,
          adjusted_total_email_count: 10,
        },
      ],
      getProviderwiseReport: async (id: number | string) => {
        requested.push(String(id));
        throw new Error("Rate limit exceeded");
      },
    } as unknown as SmartDeliveryClient;
    const smartlead = {
      listCampaigns: async () => [
        { id: 7, name: "Campaign Seven", status: "ACTIVE" },
        { id: 8, name: "Campaign Eight", status: "ACTIVE" },
      ],
    } as unknown as SmartleadClient;
    const service = new PlacementResultsService(
      smartDelivery,
      bookOf(smartlead),
      state,
      1,
    );
    const result = await service.get(true);
    assert.deepEqual(requested, ["101"]);
    assert.equal(result.rows.length, 2);
    assert.match(result.errors.join(" "), /SmartDelivery rate-limited/i);
  });

  it("does not replace a full snapshot with 4 live tests from a truncated catalog page", async () => {
    const state = await stateFixture();
    const campaigns = [];
    const snapshotRows = [];
    for (let i = 1; i <= 12; i += 1) {
      const campaignId = 200 + i;
      campaigns.push({
        id: campaignId,
        name: `Campaign ${campaignId}`,
        status: "ACTIVE",
      });
      state.markCampaignTested({
        campaignId,
        campaignName: `Campaign ${campaignId}`,
        testedAt: new Date().toISOString(),
        testIds: [String(8000 + i)],
        mailboxCount: 3,
        testsCreated: 1,
      });
      snapshotRows.push({
        id: String(8000 + i),
        name: `Auto: Campaign ${campaignId}`,
        campaignId,
        campaignName: `Campaign ${campaignId}`,
        status: "COMPLETED",
        inboxPercent: 70,
        spamPercent: 20,
        googleInboxPercent: 75,
        microsoftInboxPercent: 100,
        totalSeeds: 10,
        providers: [],
      });
    }
    state.setPlacementResults({
      generatedAt: "2026-09-09T12:00:00.000Z",
      complete: true,
      rows: snapshotRows,
    });

    const pageOne = [];
    for (let i = 0; i < 96; i += 1) {
      pageOne.push({
        spam_test_id: 9000 + i,
        test_name: `Canary copy: #${201 + (i % 12)} Campaign ${201 + (i % 12)}`,
        status: "COMPLETED",
        created_at: `2026-09-21T18:00:${String(i).padStart(2, "0")}Z`,
        campaign_id: 201 + (i % 12),
        inbox_count: 9,
        spam_count: 1,
        adjusted_total_email_count: 10,
      });
    }
    for (let i = 1; i <= 4; i += 1) {
      pageOne.push({
        spam_test_id: 8000 + i,
        test_name: `Auto: Campaign ${200 + i}`,
        status: "COMPLETED",
        created_at: `2026-09-21T17:00:0${i}Z`,
        campaign_id: 200 + i,
        inbox_count: 7,
        spam_count: 2,
        adjusted_total_email_count: 10,
      });
    }

    let listCalls = 0;
    let providerCalls = 0;
    const smartDelivery = {
      listTests: async (body: { offset?: number } = {}) => {
        listCalls += 1;
        if (Number(body.offset ?? 0) > 0) {
          throw new Error("Rate limit exceeded");
        }
        return pageOne;
      },
      getProviderwiseReport: async () => {
        providerCalls += 1;
        throw new Error("should not pull providers after a truncated catalog");
      },
    } as unknown as SmartDeliveryClient;
    const smartlead = {
      listCampaigns: async () => campaigns,
    } as unknown as SmartleadClient;
    const service = new PlacementResultsService(
      smartDelivery,
      bookOf(smartlead),
      state,
      1,
      60_000,
    );
    const result = await service.get(true);
    assert.equal(result.rows.length, 12, "kept the full snapshot, not 4 live from page 1");
    assert.equal(result.stale, true);
    assert.equal(state.getPlacementResults()?.rows.length, 12);
    assert.equal(providerCalls, 0);
    assert.ok(listCalls >= 2, "paged once then 429'd");
  });

  it("shows every known live test when the saved snapshot and the catalog page are only 4", async () => {
    const state = await stateFixture();
    const campaigns = [];
    const snapshotRows = [];
    for (let i = 1; i <= 12; i += 1) {
      const campaignId = 300 + i;
      campaigns.push({
        id: campaignId,
        name: `Campaign ${campaignId}`,
        status: "ACTIVE",
      });
      state.markCampaignTested({
        campaignId,
        campaignName: `Campaign ${campaignId}`,
        testedAt: new Date().toISOString(),
        testIds: [String(7000 + i)],
        mailboxCount: 3,
        testsCreated: 1,
      });
      if (i <= 4) {
        snapshotRows.push({
          id: String(7000 + i),
          name: `Auto: Campaign ${campaignId}`,
          campaignId,
          campaignName: `Campaign ${campaignId}`,
          status: "COMPLETED",
          inboxPercent: 70,
          spamPercent: 20,
          googleInboxPercent: 75,
          microsoftInboxPercent: 100,
          totalSeeds: 10,
          providers: [],
        });
      }
    }
    state.setPlacementResults({
      generatedAt: new Date().toISOString(),
      rows: snapshotRows,
    });
    const smartDelivery = {
      listTests: async () => {
        throw new Error("Rate limit exceeded");
      },
      getProviderwiseReport: async () => {
        throw new Error("should not fetch providers when the catalog 429s");
      },
    } as unknown as SmartDeliveryClient;
    const smartlead = {
      listCampaigns: async () => campaigns,
    } as unknown as SmartleadClient;
    const service = new PlacementResultsService(
      smartDelivery,
      bookOf(smartlead),
      state,
      60_000,
    );
    const result = await service.get();
    assert.equal(result.rows.length, 12);
    assert.equal(state.getPlacementResults()?.rows.length, 12);
    assert.equal(result.complete, true);
  });

  it("retries a 4-row incomplete snapshot instead of treating it as the whole board", async () => {
    const state = await stateFixture();
    state.setPlacementResults({
      generatedAt: new Date().toISOString(),
      rows: [
        {
          id: "101",
          name: "Auto: Campaign Seven",
          campaignId: 7,
          campaignName: "Campaign Seven",
          status: "COMPLETED",
          inboxPercent: 70,
          spamPercent: 20,
          googleInboxPercent: 75,
          microsoftInboxPercent: 100,
          totalSeeds: 10,
          providers: [],
        },
        {
          id: "102",
          name: "Auto: Campaign Eight",
          campaignId: 8,
          campaignName: "Campaign Eight",
          status: "COMPLETED",
          inboxPercent: 80,
          spamPercent: 10,
          googleInboxPercent: 80,
          microsoftInboxPercent: 80,
          totalSeeds: 10,
          providers: [],
        },
        {
          id: "103",
          name: "Auto: Campaign Nine",
          campaignId: 9,
          campaignName: "Campaign Nine",
          status: "COMPLETED",
          inboxPercent: 80,
          spamPercent: 10,
          googleInboxPercent: 80,
          microsoftInboxPercent: 80,
          totalSeeds: 10,
          providers: [],
        },
        {
          id: "104",
          name: "Auto: Campaign Ten",
          campaignId: 10,
          campaignName: "Campaign Ten",
          status: "COMPLETED",
          inboxPercent: 80,
          spamPercent: 10,
          googleInboxPercent: 80,
          microsoftInboxPercent: 80,
          totalSeeds: 10,
          providers: [],
        },
      ],
    });
    let listCalls = 0;
    const smartDelivery = {
      listTests: async () => {
        listCalls += 1;
        throw new Error("Rate limit exceeded");
      },
      getProviderwiseReport: async () => ({ result: [] }),
    } as unknown as SmartDeliveryClient;
    const smartlead = {
      listCampaigns: async () => [
        { id: 7, name: "Campaign Seven", status: "ACTIVE" },
        { id: 8, name: "Campaign Eight", status: "ACTIVE" },
        { id: 9, name: "Campaign Nine", status: "ACTIVE" },
        { id: 10, name: "Campaign Ten", status: "ACTIVE" },
      ],
    } as unknown as SmartleadClient;
    const service = new PlacementResultsService(
      smartDelivery,
      bookOf(smartlead),
      state,
      60_000,
    );
    const result = await service.get();
    assert.equal(listCalls, 1, "a 4-row snapshot without complete does not skip the refresh");
    assert.equal(result.rows.length, 4);
    assert.equal(result.stale, true);
  });

  it("ops Placement tab does not stack the snapshot sentence on the rate-limit error", async () => {
    const { readFile } = await import("node:fs/promises");
    const app = await readFile(
      new URL("../../public/ops/app.js", import.meta.url),
      "utf8",
    );
    assert.match(
      app,
      /banner\.className = "muted"/,
      "stale snapshot notice is muted, not a red error",
    );
    assert.equal(
      /Showing the last saved snapshot[\s\S]{0,250}\.\.\.errors/.test(app),
      false,
      "stale banner and errors[] used to be concatenated into one red line",
    );
  });
});

describe("FleetSummaryService", () => {
  it("counts distinct mailboxes on active campaigns", async () => {
    const state = await stateFixture();
    const smartlead = {
      listCampaigns: async () => [
        { id: 1, name: "Active", status: "ACTIVE" },
        { id: 2, name: "Paused", status: "PAUSED" },
      ],
      listAllEmailAccounts: async () => [
        { id: 1, from_email: "sending@example.com", campaign_ids: [1] },
        { id: 2, from_email: "paused@example.com", campaign_ids: [2] },
        {
          id: 3,
          from_email: "broken@example.com",
          campaign_ids: [],
          is_smtp_success: false,
        },
      ],
    } as unknown as SmartleadClient;
    const service = new FleetSummaryService(bookOf(smartlead), state);
    const result = await service.get();

    assert.equal(result.totalMailboxes, 3);
    assert.equal(result.sendingMailboxes, 1);
    assert.equal(result.activeCampaigns, 1);
    assert.equal(result.disconnectedMailboxes, 1);
  });

  it("deduplicates concurrent forced fleet refreshes", async () => {
    const state = await stateFixture();
    let accountCalls = 0;
    const smartlead = {
      listCampaigns: async () => [
        { id: 1, name: "Active", status: "ACTIVE" },
      ],
      listAllEmailAccounts: async () => {
        accountCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return [
          { id: 1, from_email: "sending@example.com", campaign_ids: [1] },
        ];
      },
    } as unknown as SmartleadClient;
    const service = new FleetSummaryService(bookOf(smartlead), state);
    const [first, second] = await Promise.all([
      service.get(true),
      service.get(true),
    ]);
    assert.equal(accountCalls, 1);
    assert.deepEqual(first, second);
  });

  it("falls back to the last persisted census when Smartlead is throttled", async () => {
    const state = await stateFixture();
    state.setFleetSummary({
      generatedAt: "2026-08-01T12:00:00.000Z",
      totalMailboxes: 1002,
      sendingMailboxes: 420,
      activeCampaigns: 9,
      disconnectedMailboxes: 3,
    });
    const smartlead = {
      listCampaigns: async () => {
        throw new Error("HTTP 429");
      },
      listAllEmailAccounts: async () => {
        throw new Error("HTTP 429");
      },
    } as unknown as SmartleadClient;
    const service = new FleetSummaryService(bookOf(smartlead), state);
    const result = await service.get(true);
    assert.equal(result.sendingMailboxes, 420);
    assert.equal(result.stale, true);
    assert.match(result.error!, /429/);
  });
});
