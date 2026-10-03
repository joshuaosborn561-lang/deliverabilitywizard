import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { SmartleadClient } from "./smartlead.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("SmartleadClient.addEmailAccountsToCampaign", () => {
  it("refuses isolation-domain mailbox IDs before any write", async () => {
    const { IsolationAttachBlockedError } = await import(
      "../lib/isolationDomain.js"
    );
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const client = new SmartleadClient("test-key");
    client.setIsolationDenylist([77, 88]);
    await assert.rejects(
      () => client.addEmailAccountsToCampaign(1, [11, 77]),
      IsolationAttachBlockedError,
    );
    assert.equal(called, false);
  });
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

describe("SmartleadClient.listAllEmailAccounts (D220)", () => {
  it("pages GET /email-accounts limit=100 until the response is empty", async () => {
    const offsets: number[] = [];
    const limits: number[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const offset = Number(url.searchParams.get("offset") ?? "0");
      const limit = Number(url.searchParams.get("limit") ?? "0");
      offsets.push(offset);
      limits.push(limit);
      const rows =
        offset === 0
          ? Array.from({ length: 100 }, (_, i) => ({ id: i + 1 }))
          : offset === 100
            ? Array.from({ length: 40 }, (_, i) => ({ id: 101 + i }))
            : [];
      return new Response(JSON.stringify(rows), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const client = new SmartleadClient("test-key");
    const accounts = await client.listAllEmailAccounts();
    assert.equal(accounts.length, 140);
    assert.deepEqual(limits, [100, 100, 100]);
    assert.deepEqual(offsets, [0, 100, 140]);
  });

  it("throws on a non-list page instead of returning a partial fleet", async () => {
    const { IncompleteEmailAccountListError } = await import("./smartlead.js");
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify([{ id: 1 }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "truncated" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const client = new SmartleadClient("test-key");
    await assert.rejects(
      () => client.listAllEmailAccounts(),
      IncompleteEmailAccountListError,
    );
  });
});
