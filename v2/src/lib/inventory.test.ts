import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { V2_INVENTORY_MAX_AGE_MS } from "../canon/constants.js";
import { MemoryStore } from "../store.js";
import {
  applyCampaignMembers,
  campaignsMissingMembers,
  dedupeById,
  inventoryIsFresh,
  loadOrRefreshInventory,
  mergeCampaignMemberships,
  staffingInventoryReady,
} from "./inventory.js";

describe("inventory campaign upsert / dedupe", () => {
  it("dedupes duplicate campaign ids (4160571) keeping the last row", () => {
    const rows = dedupeById([
      { id: 4160571, name: "first" },
      { id: 1, name: "other" },
      { id: 4160571, name: "last" },
    ]);
    assert.equal(rows.length, 2);
    assert.equal(rows.find((r) => r.id === 4160571)?.name, "last");
  });

  it("MemoryStore.saveInventory collapses duplicate campaign ids", async () => {
    const store = new MemoryStore();
    await store.saveInventory({
      fetchedAt: new Date().toISOString(),
      campaigns: [
        { id: 4160571, name: "A", status: "ACTIVE", clientId: 1 },
        { id: 4160571, name: "B", status: "PAUSED", clientId: 1 },
      ],
      accounts: [
        {
          id: 9,
          email: "a@x.test",
          fromName: "A",
          clientId: 1,
          campaignIds: [4160571],
          tags: [],
          smtpOk: true,
          imapOk: true,
          messagePerDay: 30,
          warmupBlocked: false,
          createdAt: null,
          warmupStartedAt: null,
          signature: "",
        },
        {
          id: 9,
          email: "b@x.test",
          fromName: "B",
          clientId: 1,
          campaignIds: [4160571],
          tags: [],
          smtpOk: true,
          imapOk: true,
          messagePerDay: 30,
          warmupBlocked: false,
          createdAt: null,
          warmupStartedAt: null,
          signature: "",
        },
      ],
    });
    const book = await store.loadInventory();
    assert.equal(book?.campaigns.length, 1);
    assert.equal(book?.campaigns[0]?.name, "B");
    assert.equal(book?.accounts.length, 1);
    assert.equal(book?.accounts[0]?.email, "b@x.test");
  });
});

describe("campaign membership hydrate", () => {
  it("merges campaign members and lists campaigns still missing them", () => {
    const accounts = [
      {
        id: 1,
        email: "a@x.test",
        fromName: "A",
        clientId: 1,
        campaignIds: [],
        tags: [],
        smtpOk: true,
        imapOk: true,
        messagePerDay: 30,
        warmupBlocked: false,
        createdAt: null,
        warmupStartedAt: null,
        signature: "",
      },
    ];
    const campaigns = [
      { id: 10, name: "A", status: "ACTIVE", clientId: 1 },
      { id: 11, name: "B", status: "ACTIVE", clientId: 1 },
    ];
    assert.equal(campaignsMissingMembers(campaigns, accounts).length, 2);
    const merged = mergeCampaignMemberships(accounts, [{ campaignId: 10, accountIds: [1] }]);
    assert.deepEqual(merged[0]?.campaignIds, [10]);
    const applied = applyCampaignMembers(merged, 11, [{ ...accounts[0]!, id: 1, campaignIds: [] }]);
    assert.ok(applied[0]?.campaignIds.includes(11));
    assert.equal(staffingInventoryReady({ fetchedAt: new Date().toISOString(), campaigns, accounts }), true);
    const many = Array.from({ length: 8 }, (_, i) => ({
      id: 20 + i,
      name: `C${i}`,
      status: "ACTIVE",
      clientId: 1,
    }));
    assert.equal(
      staffingInventoryReady({ fetchedAt: new Date().toISOString(), campaigns: many, accounts }),
      false,
    );
    assert.equal(
      staffingInventoryReady({ fetchedAt: new Date().toISOString(), campaigns: many, accounts: applied }),
      true,
    );
  });
});

describe("D278 staff inventory every 30 minutes", () => {
  it("reuses a book younger than 30 minutes and refreshes an older one", async () => {
    assert.equal(V2_INVENTORY_MAX_AGE_MS, 30 * 60 * 1000);
    const now = Date.parse("2026-10-15T18:00:00.000Z");
    const fresh = {
      fetchedAt: new Date(now - 29 * 60 * 1000).toISOString(),
      campaigns: [],
      accounts: [],
    };
    const stale = {
      fetchedAt: new Date(now - 30 * 60 * 1000).toISOString(),
      campaigns: [],
      accounts: [],
    };
    assert.equal(inventoryIsFresh(fresh, now), true);
    assert.equal(inventoryIsFresh(stale, now), false);
    assert.equal(inventoryIsFresh(null, now), false);

    const store = new MemoryStore();
    await store.saveInventory(fresh);
    let fetches = 0;
    const hit = await loadOrRefreshInventory(
      store,
      async () => {
        fetches += 1;
        return { fetchedAt: new Date(now).toISOString(), campaigns: [], accounts: [] };
      },
      now,
    );
    assert.equal(hit.refreshed, false);
    assert.equal(fetches, 0);

    await store.saveInventory(stale);
    const miss = await loadOrRefreshInventory(
      store,
      async () => {
        fetches += 1;
        return { fetchedAt: new Date(now).toISOString(), campaigns: [], accounts: [] };
      },
      now,
    );
    assert.equal(miss.refreshed, true);
    assert.equal(fetches, 1);
  });

  it("refreshes a fresh book that has living campaigns but zero campaign_ids", async () => {
    const now = Date.parse("2026-10-15T18:00:00.000Z");
    const emptyMembers = {
      fetchedAt: new Date(now - 5 * 60 * 1000).toISOString(),
      campaigns: Array.from({ length: 8 }, (_, i) => ({
        id: i + 1,
        name: `C${i}`,
        status: "ACTIVE",
        clientId: 1,
      })),
      accounts: [
        {
          id: 9,
          email: "a@x.test",
          fromName: "A",
          clientId: 1,
          campaignIds: [],
          tags: [],
          smtpOk: true,
          imapOk: true,
          messagePerDay: 30,
          warmupBlocked: false,
          createdAt: null,
          warmupStartedAt: null,
          signature: "",
        },
      ],
    };
    const store = new MemoryStore();
    await store.saveInventory(emptyMembers);
    let fetches = 0;
    const miss = await loadOrRefreshInventory(
      store,
      async () => {
        fetches += 1;
        return { fetchedAt: new Date(now).toISOString(), campaigns: [], accounts: [] };
      },
      now,
    );
    assert.equal(miss.refreshed, true);
    assert.equal(fetches, 1);
  });
});

