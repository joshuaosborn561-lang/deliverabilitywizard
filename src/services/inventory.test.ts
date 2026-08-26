import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fetchInventory,
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
