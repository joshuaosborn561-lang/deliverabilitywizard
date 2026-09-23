import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SmartDeliveryClient } from "../clients/smartdelivery.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import { StateStore } from "../state/store.js";
import type { InventoryBook } from "./inventory.js";
import {
  FleetSummaryService,
  PlacementResultsService,
  latestPlacementAt,
  newestPlacementTestId,
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
    assert.equal(result.rows[0]?.inboxPercent, (8 / 9) * 100);
    assert.equal(result.rows[0]?.googleInboxPercent, 75);
    assert.equal(result.rows[0]?.microsoftInboxPercent, 100);
    assert.equal(result.rows[0]?.spamPercent, (1 / 9) * 100);
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
        { id: 8, name: "Campaign Eight", status: "ACTIVE" },
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
    assert.deepEqual(requested, ["102"], "a 429 spends the one call on the newer test");
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
    campaigns.push({
      id: 999,
      name: "Campaign Missing",
      status: "ACTIVE",
    });
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
    assert.equal(state.getPlacementResults()?.listOffset, 100);
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
    let listCalls = 0;
    const fetched: string[] = [];
    const smartDelivery = {
      listTests: async () => {
        listCalls += 1;
        throw new Error("Rate limit exceeded");
      },
      getProviderwiseReport: async (id: number | string) => {
        fetched.push(String(id));
        return {
          status: "COMPLETED",
          result: [
            {
              provider_name: "G Suite",
              inbox_count: 8,
              spam_count: 2,
              adjusted_total_email_count: 10,
            },
            {
              provider_name: "Office365",
              inbox_count: 6,
              spam_count: 4,
              adjusted_total_email_count: 10,
            },
          ],
        };
      },
      getTestDetails: async () => ({
        updated_at: new Date().toISOString(),
        test_run_no: 4,
        status: "ACTIVE",
      }),
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
    assert.equal(listCalls, 0, "a mostly unscored board does not burn the catalog");
    assert.equal(fetched.length, 8, "only the rows still missing Google/Microsoft are fetched");
    const filled = result.rows.filter((row) => row.id === "7012");
    assert.equal(filled[0]?.status, "COMPLETED");
    assert.equal(filled[0]?.googleInboxPercent, 80);
    assert.equal(filled[0]?.microsoftInboxPercent, 60);
    assert.equal(
      result.rows.filter((row) => row.status === "UNKNOWN").length,
      0,
    );
    assert.equal(state.getPlacementResults()?.rows.length, 12);
    assert.equal(result.complete, true);
  });

  it("does not walk the catalog when every live campaign already has a row", async () => {
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
    assert.equal(listCalls, 0, "every live campaign already has a row");
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
    assert.match(
      app,
      /data\.complete === false && !data\.stale/,
      "an unfinished catalog walk keeps loading on the Placement tab",
    );
  });

  it("keeps the newest test per campaign and does not date it with the first mark", async () => {
    const state = await stateFixture();
    const testedAt = "2026-07-01T00:00:00.000Z";
    state.markCampaignTested({
      campaignId: 7,
      campaignName: "Campaign Seven",
      testedAt,
      testIds: ["999", "1000"],
      mailboxCount: 5,
      testsCreated: 2,
    });
    state.setPlacementResults({
      generatedAt: "2026-09-01T00:00:00.000Z",
      rows: [
        {
          id: "999",
          name: "Auto: Campaign Seven",
          campaignId: 7,
          campaignName: "Campaign Seven",
          status: "COMPLETED",
          createdAt: testedAt,
          inboxPercent: 10,
          spamPercent: 80,
          googleInboxPercent: 10,
          microsoftInboxPercent: 10,
          totalSeeds: 10,
          providers: [],
        },
      ],
    });
    const fetched: string[] = [];
    const smartDelivery = {
      listTests: async () => [],
      getProviderwiseReport: async (id: number | string) => {
        fetched.push(String(id));
        return {
          status: "COMPLETED",
          result: [
            {
              provider_name: "G Suite",
              inbox_count: 8,
              spam_count: 2,
              adjusted_total_email_count: 10,
            },
            {
              provider_name: "Office365",
              inbox_count: 6,
              spam_count: 4,
              adjusted_total_email_count: 10,
            },
          ],
        };
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
    const result = await service.get(true);
    assert.deepEqual(
      result.rows.map((row) => row.id),
      ["1000"],
    );
    assert.deepEqual(fetched, ["1000"]);
    assert.notEqual(result.rows[0]?.createdAt, testedAt);
    assert.equal(result.rows[0]?.googleInboxPercent, 80);
    assert.equal(state.getPlacementResults()?.rows[0]?.id, "1000");
  });

  it("fills inbox, spam, seeds, date, and run when a row only had ESP scores", async () => {
    const state = await stateFixture();
    state.setPlacementResults({
      generatedAt: "2026-09-21T00:00:00.000Z",
      rows: [
        {
          id: "101",
          name: "Auto: Campaign Seven",
          campaignId: 7,
          campaignName: "Campaign Seven",
          status: "COMPLETED",
          googleInboxPercent: 80,
          microsoftInboxPercent: 100,
          totalSeeds: 0,
          providers: [],
        },
      ],
    });
    const smartDelivery = {
      listTests: async () => [],
      getProviderwiseReport: async () => ({
        status: "ACTIVE",
        result: [
          {
            provider_name: "G Suite",
            inbox_count: 85,
            spam_count: 2,
            tab_count: 0,
            adjusted_total_email_count: 87,
          },
          {
            provider_name: "Office365",
            inbox_count: 71,
            spam_count: 0,
            tab_count: 0,
            adjusted_total_email_count: 71,
          },
        ],
      }),
      getTestDetails: async () => ({
        updated_at: "2026-09-22T06:37:03.220Z",
        test_run_no: 5,
        status: "ACTIVE",
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
      60_000,
    );
    const result = await service.get(true);
    const row = result.rows[0];
    assert.equal(row?.status, "ACTIVE");
    assert.equal(row?.googleInboxPercent, (85 / 87) * 100);
    assert.equal(row?.microsoftInboxPercent, 100);
    assert.equal(row?.inboxPercent, (156 / 158) * 100);
    assert.equal(row?.spamPercent, (2 / 158) * 100);
    assert.equal(row?.totalSeeds, 158);
    assert.equal(row?.createdAt, "2026-09-22T06:37:03.220Z");
    assert.equal(row?.runNumber, 5);
    assert.equal(result.complete, true);
  });

  it("dates a scored test from its latest run instead of the schedule start", async () => {
    const state = await stateFixture();
    state.setPlacementResults({
      generatedAt: "2026-09-21T00:00:00.000Z",
      complete: false,
      rows: [
        {
          id: "101",
          name: "Auto: Campaign Seven",
          campaignId: 7,
          campaignName: "Campaign Seven",
          status: "COMPLETED",
          createdAt: "2026-08-01T00:00:00.000Z",
          inboxPercent: 70,
          spamPercent: 20,
          googleInboxPercent: 75,
          microsoftInboxPercent: 100,
          totalSeeds: 10,
          providers: [],
        },
      ],
    });
    let providerCalls = 0;
    const smartDelivery = {
      listTests: async () => [
        {
          spam_test_id: 101,
          test_name: "Auto: Campaign Seven",
          status: "active",
          created_at: "2026-08-01T00:00:00.000Z",
          campaign_id: 7,
          inbox_count: 7,
          spam_count: 2,
          adjusted_total_email_count: 10,
        },
      ],
      getProviderwiseReport: async () => {
        providerCalls += 1;
        return { result: [] };
      },
      getTestDetails: async () => ({
        status: "active",
        schedule_start_time: "2026-08-01T00:00:00.000Z",
        every_days: 1,
        current_test_run_no: 52,
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
      60_000,
    );
    const result = await service.get(true);
    assert.equal(providerCalls, 0, "a scored row spends the call on its run date");
    assert.equal(result.rows[0]?.runNumber, 52);
    assert.equal(result.rows[0]?.createdAt, "2026-09-21T00:00:00.000Z");
    assert.equal(state.getPlacementResults()?.rows[0]?.createdAt, "2026-09-21T00:00:00.000Z");
  });

  it("resumes past pod-control pages and attaches an Auto test that has no campaign id", async () => {
    const state = await stateFixture();
    const offsets: number[] = [];
    const smartDelivery = {
      listTests: async (body: { offset?: number } = {}) => {
        const offset = Number(body.offset ?? 0);
        offsets.push(offset);
        if (offset < 200) {
          return Array.from({ length: 100 }, (_, i) => ({
            spam_test_id: 1000 + offset + i,
            test_name: `Pod control: ${offset + i}`,
            status: "ACTIVE",
            created_at: "2026-09-23T12:00:00.000Z",
          }));
        }
        return [
          {
            spam_test_id: 41,
            test_name: "Canary copy: #8 Campaign Eight",
            status: "ACTIVE",
            created_at: "2026-09-23T12:00:00.000Z",
          },
          {
            spam_test_id: 40,
            test_name: "Pod control: leftover",
            status: "ACTIVE",
            created_at: "2026-09-23T12:00:00.000Z",
          },
          {
            spam_test_id: 42,
            test_name: "Auto: Campaign Eight (1/2)",
            status: "ACTIVE",
            created_at: "2026-09-20T00:00:00.000Z",
            inbox_count: 8,
            spam_count: 1,
            adjusted_total_email_count: 10,
          },
        ];
      },
      getProviderwiseReport: async () => ({
        status: "ACTIVE",
        result: [
          {
            provider_name: "G Suite",
            inbox_count: 8,
            spam_count: 1,
            adjusted_total_email_count: 10,
          },
        ],
      }),
      getTestDetails: async () => ({
        updated_at: "2026-09-22T06:37:03.220Z",
        test_run_no: 3,
        status: "ACTIVE",
      }),
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
    const first = await service.get(true);
    assert.deepEqual(offsets, [0, 100]);
    assert.equal(
      first.rows.some((row) => row.campaignId === 8),
      false,
    );
    assert.equal(state.getPlacementResults()?.listOffset, 200);

    const second = await service.get(true);
    assert.deepEqual(offsets, [0, 100, 200]);
    const found = second.rows.find((row) => row.campaignId === 8);
    assert.equal(found?.id, "42");
    assert.equal(found?.campaignName, "Campaign Eight");
    assert.equal(found?.name, "Auto: Campaign Eight (1/2)");
    assert.equal(
      second.rows.some((row) => row.name.includes("Pod control")),
      false,
    );
    assert.equal(
      second.rows.some((row) => row.name.includes("Canary copy")),
      false,
    );
    assert.equal(state.getPlacementResults()?.listOffset, 0);
  });

  it("keeps the catalog offset when the next page is rate limited", async () => {
    const state = await stateFixture();
    const offsets: number[] = [];
    const smartDelivery = {
      listTests: async (body: { offset?: number } = {}) => {
        const offset = Number(body.offset ?? 0);
        offsets.push(offset);
        if (offset > 0) throw new Error("Rate limit exceeded");
        return Array.from({ length: 100 }, (_, i) => ({
          spam_test_id: 3000 + i,
          test_name: `Pod control: ${i}`,
          status: "ACTIVE",
          created_at: "2026-09-23T12:00:00.000Z",
        }));
      },
      getProviderwiseReport: async () => ({
        status: "COMPLETED",
        result: [
          {
            provider_name: "G Suite",
            inbox_count: 8,
            spam_count: 1,
            adjusted_total_email_count: 10,
          },
        ],
      }),
      getTestDetails: async () => ({
        updated_at: "2026-09-22T06:37:03.220Z",
        test_run_no: 2,
        status: "ACTIVE",
      }),
    } as unknown as SmartDeliveryClient;
    const smartlead = {
      listCampaigns: async () => [
        { id: 7, name: "Campaign Seven", status: "ACTIVE" },
        { id: 8, name: "Campaign Eight", status: "ACTIVE" },
      ],
    } as unknown as SmartleadClient;
    const firstService = new PlacementResultsService(
      smartDelivery,
      bookOf(smartlead),
      state,
      1,
      60_000,
    );
    await firstService.get(true);
    assert.deepEqual(offsets, [0, 100]);
    assert.equal(state.getPlacementResults()?.listOffset, 100);

    const secondService = new PlacementResultsService(
      smartDelivery,
      bookOf(smartlead),
      state,
      1,
      60_000,
    );
    await secondService.get(true);
    assert.equal(offsets.at(-1), 100);
    assert.equal(
      offsets.filter((offset) => offset === 0).length,
      1,
      "a 429 must not restart the walk at the pod-control pages",
    );
  });
});

describe("latestPlacementAt", () => {
  it("prefers the latest scheduled run over the day the test was created", () => {
    assert.equal(newestPlacementTestId(["999", "1000", "101"]), "1000");
    assert.equal(
      latestPlacementAt(
        {
          created_at: "2026-08-01T00:00:00.000Z",
          schedule_start_time: "2026-08-01T00:00:00.000Z",
          every_days: 1,
          current_test_run_no: 52,
        },
        Date.parse("2026-09-22T00:00:00.000Z"),
      ),
      "2026-09-21T00:00:00.000Z",
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
