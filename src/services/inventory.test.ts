import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fetchInventory,
  InventoryBook,
  isSmartleadRateLimit,
} from "./inventory.js";

describe("fetchInventory 429 retry (D122)", () => {
  it("retries a rate-limit error and returns the later snapshot", async () => {
    let calls = 0;
    const slept: number[] = [];
    const snapshot = await fetchInventory(
      {
        listCampaigns: async () => {
          calls += 1;
          if (calls < 3) throw new Error("HTTP 429");
          return [{ id: 1, name: "Live", status: "ACTIVE" }];
        },
        listAllEmailAccounts: async () => [],
        listClients: async () => [],
      },
      {
        retryDelayMs: 15,
        sleep: async (ms) => {
          slept.push(ms);
        },
      },
    );
    assert.equal(calls, 3);
    assert.deepEqual(slept, [15, 15]);
    assert.equal(snapshot.campaigns[0]?.id, 1);
  });

  it("does not retry a non-429 error", async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        fetchInventory(
          {
            listCampaigns: async () => {
              calls += 1;
              throw new Error("HTTP 500");
            },
            listAllEmailAccounts: async () => [],
          },
          { retryDelayMs: 1, sleep: async () => undefined },
        ),
      /HTTP 500/,
    );
    assert.equal(calls, 1);
  });

  it("detects Smartlead rate-limit wording", () => {
    assert.equal(isSmartleadRateLimit(new Error("HTTP 429")), true);
    assert.equal(
      isSmartleadRateLimit(new Error("Rate limit exceeded. Please try again later.")),
      true,
    );
    assert.equal(isSmartleadRateLimit(new Error("HTTP 404")), false);
  });
});
describe("InventoryBook — one account book, partial reads distrusted (D132)", () => {
  const client = (accounts: number, opts: { fail?: boolean } = {}) => {
    const calls = { count: 0 };
    return {
      calls,
      sl: {
        listCampaigns: async () => {
          calls.count += 1;
          if (opts.fail) throw new Error("HTTP 429");
          return [{ id: 1, name: "Live", status: "ACTIVE" }];
        },
        listAllEmailAccounts: async () =>
          Array.from({ length: accounts }, (_, i) => ({
            id: i + 1,
            from_email: `a${i}@x.com`,
          })),
        listClients: async () => [],
      },
    };
  };

  it("serves the cached snapshot while fresh, refetches when stale", async () => {
    let nowMs = 1_000_000;
    const { sl, calls } = client(10);
    const book = new InventoryBook(sl as never, 15 * 60 * 1000, () => nowMs);
    const first = await book.get();
    assert.equal(first.accounts.length, 10);
    assert.equal(calls.count, 1);
    const cached = await book.get();
    assert.equal(cached, first);
    assert.equal(calls.count, 1);
    nowMs += 16 * 60 * 1000;
    await book.get();
    assert.equal(calls.count, 2);
  });

  it("carries over the accepted book when the fetch dies", async () => {
    let nowMs = 1_000_000;
    let fail = false;
    const good = client(10);
    const book = new InventoryBook(
      {
        listCampaigns: async () => {
          if (fail) throw new Error("HTTP 500 boom");
          return good.sl.listCampaigns();
        },
        listAllEmailAccounts: good.sl.listAllEmailAccounts,
        listClients: good.sl.listClients,
      } as never,
      15 * 60 * 1000,
      () => nowMs,
    );
    const first = await book.get();
    fail = true;
    nowMs += 20 * 60 * 1000;
    const carried = await book.get();
    assert.equal(carried, first);
  });

  it("holds a shrunken read once, believes the second in a row", async () => {
    let nowMs = 1_000_000;
    let accounts = 10;
    const sl = {
      listCampaigns: async () => [],
      listAllEmailAccounts: async () =>
        Array.from({ length: accounts }, (_, i) => ({ id: i + 1 })),
      listClients: async () => [],
    };
    const book = new InventoryBook(sl as never, 15 * 60 * 1000, () => nowMs);
    const first = await book.get();
    assert.equal(first.accounts.length, 10);

    accounts = 3; // below the 80% floor — suspected partial read
    nowMs += 20 * 60 * 1000;
    const held = await book.get();
    assert.equal(held.accounts.length, 10, "first shrunken read is not believed");

    nowMs += 20 * 60 * 1000;
    const believed = await book.get();
    assert.equal(believed.accounts.length, 3, "second shrunken read in a row is");
  });

  it("a healthy read between shrunken ones resets the streak", async () => {
    let nowMs = 1_000_000;
    let accounts = 10;
    const sl = {
      listCampaigns: async () => [],
      listAllEmailAccounts: async () =>
        Array.from({ length: accounts }, (_, i) => ({ id: i + 1 })),
      listClients: async () => [],
    };
    const book = new InventoryBook(sl as never, 15 * 60 * 1000, () => nowMs);
    await book.get();
    accounts = 3;
    nowMs += 20 * 60 * 1000;
    await book.get(); // held
    accounts = 10;
    nowMs += 20 * 60 * 1000;
    const healthy = await book.get();
    assert.equal(healthy.accounts.length, 10);
    accounts = 3;
    nowMs += 20 * 60 * 1000;
    const heldAgain = await book.get();
    assert.equal(heldAgain.accounts.length, 10, "streak restarted after a healthy read");
  });

  it("spaces fetch attempts while unhappy instead of hammering Smartlead", async () => {
    let nowMs = 1_000_000;
    const { sl, calls } = client(10);
    const book = new InventoryBook(sl as never, 15 * 60 * 1000, () => nowMs);
    await book.fetchFresh();
    assert.equal(calls.count, 1);
    nowMs += 30 * 1000; // < 2-minute spacing
    await book.fetchFresh();
    assert.equal(calls.count, 1, "a fresh attempt this soon serves the accepted book");
    nowMs += 3 * 60 * 1000;
    await book.fetchFresh();
    assert.equal(calls.count, 2);
  });

  it("concurrent fetches share one in-flight read", async () => {
    let nowMs = 1_000_000;
    let resolveCampaigns: (v: unknown[]) => void = () => {};
    let calls = 0;
    const sl = {
      listCampaigns: () => {
        calls += 1;
        return new Promise<unknown[]>((resolve) => {
          resolveCampaigns = resolve;
        });
      },
      listAllEmailAccounts: async () => [{ id: 1 }],
      listClients: async () => [],
    };
    const book = new InventoryBook(sl as never, 15 * 60 * 1000, () => nowMs);
    const a = book.fetchFresh();
    const b = book.fetchFresh();
    resolveCampaigns([]);
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra, rb);
    assert.equal(calls, 1);
  });
});
