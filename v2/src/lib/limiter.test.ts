import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SMARTLEAD_CONCURRENCY,
  SMARTLEAD_MAX_PER_MIN,
  V2_INVENTORY_MAX_AGE_MS,
  V2_SMARTLEAD_CONCURRENCY,
  V2_SMARTLEAD_MAX_PER_MIN,
  V2_SMARTLEAD_MIN_GAP_MS,
  V2_SMARTLEAD_PAGE_DELAY_MS,
} from "../canon/constants.js";
import { RateLimitError } from "../clients/http.js";
import { MemoryStore } from "../store.js";
import { SharedSmartleadLimiter } from "./limiter.js";
import { startTick, TickTimeoutError } from "./tickClock.js";

describe("D257 account budget stays 150/min for the old wizard", () => {
  it("caps concurrency at 2 and budget at 150/min", () => {
    assert.equal(SMARTLEAD_CONCURRENCY, 2);
    assert.equal(SMARTLEAD_MAX_PER_MIN, 150);
  });
});

describe("D278/D284 v2 courtesy Smartlead limiter", () => {
  it("defaults to 60/min token bucket, concurrency 1, 30-minute inventory, page delay", () => {
    assert.equal(V2_SMARTLEAD_MAX_PER_MIN, 60);
    assert.equal(V2_SMARTLEAD_CONCURRENCY, 1);
    assert.equal(V2_SMARTLEAD_MIN_GAP_MS, 1_000);
    assert.equal(V2_INVENTORY_MAX_AGE_MS, 30 * 60 * 1000);
    assert.equal(V2_SMARTLEAD_PAGE_DELAY_MS, 500);
    const limiter = new SharedSmartleadLimiter();
    const snap = limiter.snapshot();
    assert.equal(snap.maxPerMin, 60);
    assert.equal(snap.concurrency, 1);
  });

  it("shares inflight slots on the store used by both roles at concurrency 1", async () => {
    const store = new MemoryStore();
    const limiter = new SharedSmartleadLimiter(store, 1, 60, 0);
    let concurrent = 0;
    let max = 0;
    await Promise.all(
      [1, 2, 3].map(() =>
        limiter.schedule(async () => {
          concurrent += 1;
          max = Math.max(max, concurrent);
          await new Promise((r) => setTimeout(r, 20));
          concurrent -= 1;
        }),
      ),
    );
    assert.ok(max <= 1);
  });

  it("backs off and retries a 429 after releasing the slot", async () => {
    const store = new MemoryStore();
    const limiter = new SharedSmartleadLimiter(store, 1, 60, 0);
    let calls = 0;
    let inflightDuringRetry = 0;
    const value = await limiter.schedule(async () => {
      calls += 1;
      inflightDuringRetry = Math.max(inflightDuringRetry, store.rate.inflight);
      if (calls === 1) throw new RateLimitError("GET /email-accounts → 429", 5);
      return "ok";
    });
    assert.equal(value, "ok");
    assert.equal(calls, 2);
    assert.equal(store.rate.inflight, 0);
    assert.ok(inflightDuringRetry <= 1);
  });

  it("rethrows after the 429 retry budget is spent", async () => {
    const limiter = new SharedSmartleadLimiter(undefined, 1, 60, 0, 2);
    let calls = 0;
    await assert.rejects(
      () =>
        limiter.schedule(async () => {
          calls += 1;
          throw new RateLimitError("429", 1);
        }),
      (err: unknown) => err instanceof RateLimitError,
    );
    assert.equal(calls, 2);
  });

  it("aborts a waiter instead of looping forever", async () => {
    const limiter = new SharedSmartleadLimiter(undefined, 1, 60, 0, 1);
    const ac = new AbortController();
    const started = limiter.schedule(() => new Promise((r) => setTimeout(r, 500)));
    await new Promise((r) => setTimeout(r, 10));
    const waiting = limiter.schedule(async () => "nope", ac.signal);
    ac.abort();
    await assert.rejects(() => waiting);
    await started;
  });

  it("expires a stuck rate slot by TTL so the next acquire is not deadlocked", async () => {
    const store = new MemoryStore();
    assert.equal(await store.acquireRateSlot(1, 60, 30), true);
    assert.equal(await store.acquireRateSlot(1, 60, 30), false);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(await store.acquireRateSlot(1, 60, 30), true);
  });

  it("honors Retry-After but will not sleep 8 hours past the tick deadline", async () => {
    const tick = startTick(60);
    const limiter = new SharedSmartleadLimiter(undefined, 1, 60, 0, 4);
    const started = Date.now();
    await assert.rejects(
      () =>
        limiter.schedule(async () => {
          throw new RateLimitError("GET /campaigns → 429", 8 * 60 * 60 * 1000);
        }, tick.signal),
      TickTimeoutError,
    );
    assert.ok(Date.now() - started < 1500, "8h Retry-After must not hold the tick");
    tick.dispose();
  });
});
