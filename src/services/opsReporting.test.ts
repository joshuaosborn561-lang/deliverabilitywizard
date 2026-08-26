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
