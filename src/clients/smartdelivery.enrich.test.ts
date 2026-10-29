import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ENRICH_BREAKER_FAILURES,
  SmartDeliveryClient,
} from "./smartdelivery.js";
import type { SpamTestSummary } from "./smartdelivery.js";

function rows(n: number): SpamTestSummary[] {
  return Array.from({ length: n }, (_, i) => ({
    spam_test_id: 1000 + i,
    test_name: `Auto: c${i}`,
    every_days: 1,
    status: "ACTIVE",
  })) as SpamTestSummary[];
}

function client(detail: (id: string | number) => Promise<Record<string, unknown>>) {
  const c = new SmartDeliveryClient("k");
  const calls: string[] = [];
  (c as unknown as { getTestDetails: unknown }).getTestDetails = async (id: string | number) => {
    calls.push(String(id));
    return detail(id);
  };
  return { c, calls };
}

describe("A4/D315 enrichCampaignIds cache", () => {
  it("fetches each test's campaign once, then serves later passes from memory", async () => {
    const { c, calls } = client(async (id) => ({ campaign_id: Number(id) - 1000 + 5 }));
    const first = await c.enrichCampaignIds(rows(5));
    assert.deepEqual(first.map((t) => t.campaign_id), [5, 6, 7, 8, 9]);
    assert.equal(calls.length, 5);
    const second = await c.enrichCampaignIds(rows(5));
    const third = await c.enrichCampaignIds(rows(5));
    assert.deepEqual(second.map((t) => t.campaign_id), [5, 6, 7, 8, 9]);
    assert.deepEqual(third.map((t) => t.campaign_id), [5, 6, 7, 8, 9]);
    assert.equal(calls.length, 5, "later passes must not refetch");
    assert.equal(c.enrichStats.hits, 10);
  });

  it("concurrent callers share one in-flight lookup", async () => {
    const { c, calls } = client(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return { campaign_id: 77 };
    });
    const [a, b, d] = await Promise.all([
      c.enrichCampaignIds(rows(2)),
      c.enrichCampaignIds(rows(2)),
      c.enrichCampaignIds(rows(2)),
    ]);
    assert.equal(calls.length, 2);
    assert.ok([a, b, d].every((x) => x.every((t) => t.campaign_id === 77)));
  });

  it("a failed lookup is not cached (429s retry next pass)", async () => {
    let fail = true;
    const { c, calls } = client(async () => {
      if (fail) throw new Error("HTTP 429");
      return { campaign_id: 9 };
    });
    const failed = await c.enrichCampaignIds(rows(1));
    assert.equal(failed[0].campaign_id, undefined);
    fail = false;
    const ok = await c.enrichCampaignIds(rows(1));
    assert.equal(ok[0].campaign_id, 9);
    assert.equal(calls.length, 2);
  });

  it("a test with no campaign is remembered for the negative TTL, not refetched every pass", async () => {
    const { c, calls } = client(async () => ({}));
    await c.enrichCampaignIds(rows(1));
    await c.enrichCampaignIds(rows(1));
    assert.equal(calls.length, 1);
  });

  it("tests that already carry a campaign id never hit the API", async () => {
    const { c, calls } = client(async () => ({ campaign_id: 1 }));
    const out = await c.enrichCampaignIds([
      { spam_test_id: 1, campaign_id: 42, every_days: 1 } as SpamTestSummary,
    ]);
    assert.equal(out[0].campaign_id, 42);
    assert.equal(calls.length, 0);
  });

  it("listTests shares one list across callers for a moment and drops it on any write", async () => {
    const c = new SmartDeliveryClient("k");
    let pages = 0;
    const inner = c as unknown as { request: (path: string, o?: { method?: string }) => Promise<unknown> };
    inner.request = async (path: string, o: { method?: string } = {}) => {
      if (path === "spam-test/report") {
        pages += 1;
        return [{ spam_test_id: 1, test_name: "t", status: "ACTIVE" }];
      }
      return {};
    };
    const [a, b] = await Promise.all([c.listTests({}), c.listTests({})]);
    await c.listTests({});
    assert.equal(pages, 1, "one HTTP list for three callers inside the TTL");
    a[0].test_name = "mutated";
    const again = await c.listTests({});
    assert.equal(again[0].test_name, "t", "callers get their own row copies");
    assert.equal(b[0].test_name, "t");
    const inv = (m: string, p: string) =>
      (c as unknown as { invalidateTestListOnWrite: (m: string, p: string) => void }).invalidateTestListOnWrite(m, p);
    inv("POST", "spam-test/report/9/providerwise"); // a read: keeps the list
    await c.listTests({});
    assert.equal(pages, 1);
    inv("POST", "spam-test/schedule"); // a write: drops the list
    await c.listTests({});
    assert.equal(pages, 2);
    inv("DELETE", "spam-test/5/stop");
    await c.listTests({});
    assert.equal(pages, 3);
  });
});

describe("D317 cold-cache lookup breaker", () => {
  it(`stops asking after ${ENRICH_BREAKER_FAILURES} failures in a row, serves rows un-enriched, keeps cached ids`, async () => {
    let fail = true;
    const { c, calls } = client(async (id) => {
      if (fail) throw new Error("HTTP 429");
      return { campaign_id: Number(id) };
    });
    const out = await c.enrichCampaignIds(rows(20));
    assert.equal(out.length, 20, "every row still comes back");
    assert.equal(calls.length, ENRICH_BREAKER_FAILURES, "breaker opened, no storm");
    assert.equal(c.enrichStats.shortCircuited, 20 - ENRICH_BREAKER_FAILURES);
    // Breaker is open: a second pass makes no network calls at all.
    await c.enrichCampaignIds(rows(20));
    assert.equal(calls.length, ENRICH_BREAKER_FAILURES);
    // The cache survives: a success after the cooldown fills it.
    fail = false;
    (c as unknown as { enrichBreakerUntil: number }).enrichBreakerUntil = 0;
    const ok = await c.enrichCampaignIds(rows(3));
    assert.deepEqual(ok.map((t) => t.campaign_id), [1000, 1001, 1002]);
  });

  it("one success resets the failure streak", async () => {
    let n = 0;
    const { c, calls } = client(async () => {
      n += 1;
      if (n % 3 !== 0) throw new Error("HTTP 429");
      return { campaign_id: 5 };
    });
    await c.enrichCampaignIds(rows(9));
    assert.equal(calls.length, 9, "2 failures then a success never trips a 3-in-a-row breaker");
  });

  it("a caller with no deadline still gets a bounded pass", async () => {
    const { c, calls } = client(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { campaign_id: 1 };
    });
    const out = await c.enrichCampaignIds(rows(4), { deadlineMs: Date.now() - 1 });
    assert.equal(calls.length, 0);
    assert.equal(out.length, 4);
  });
});
