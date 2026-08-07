import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { SmartleadClient } from "./smartlead.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("SmartleadClient.updateCampaignStatus", () => {
  it("sends POST — Smartlead's live status endpoint 404s on PATCH", async () => {
    const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const client = new SmartleadClient("test-key");
    await client.updateCampaignStatus(123, "PAUSED");

    assert.equal(calls.length, 1);
    // The docs page is titled "Patch campaign status", but PATCH 404s against
    // the live API. Pausing a campaign is how warmupGate/remediation strip the
    // last account, and how health/bounce-investigate resume it again — a
    // silent 404 here disables all four.
    assert.equal(calls[0].method, "POST");
    assert.match(calls[0].url, /campaigns\/123\/status/);
    assert.deepEqual(calls[0].body, { status: "PAUSED" });
  });

  it("carries the START status through for resumes", async () => {
    const calls: Array<{ method?: string; body?: unknown }> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const client = new SmartleadClient("test-key");
    await client.updateCampaignStatus(456, "START");

    assert.equal(calls[0].method, "POST");
    assert.deepEqual(calls[0].body, { status: "START" });
  });
});
