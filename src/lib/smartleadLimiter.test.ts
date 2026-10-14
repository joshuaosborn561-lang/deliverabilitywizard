import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApiError } from "./http.js";
import { SmartleadLimiter } from "./smartleadLimiter.js";

describe("D257 Smartlead limiter", () => {
  it("caps concurrency and backs off every waiter after a 429", async () => {
    const limiter = new SmartleadLimiter(2, 0, 50);
    let inflight = 0;
    let maxInflight = 0;
    const started: number[] = [];

    const job = async (id: number, delayMs: number): Promise<number> =>
      limiter.schedule(async () => {
        inflight += 1;
        maxInflight = Math.max(maxInflight, inflight);
        started.push(id);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        inflight -= 1;
        return id;
      });

    const first = Promise.all([job(1, 40), job(2, 40), job(3, 10)]);
    const values = await first;
    assert.deepEqual(values.slice().sort(), [1, 2, 3]);
    assert.ok(maxInflight <= 2, `concurrency leaked to ${maxInflight}`);
    assert.equal(started[0] + started[1], 3);

    const t0 = Date.now();
    limiter.noteRateLimit(40);
    await limiter.schedule(async () => 9);
    assert.ok(
      Date.now() - t0 >= 30,
      "a 429 must pause later Smartlead calls",
    );
  });

  it("treats ApiError 429 as a shared pause", async () => {
    const limiter = new SmartleadLimiter(1, 0, 20);
    await assert.rejects(
      () =>
        limiter.schedule(async () => {
          limiter.noteRateLimit(15);
          throw new ApiError("rate limited", 429, {});
        }),
      /rate limited/,
    );
    const t0 = Date.now();
    await limiter.schedule(async () => "ok");
    assert.ok(Date.now() - t0 >= 10);
    assert.equal(limiter.snapshot().rateLimitStreak, 0);
  });

  it("D267: stays under the account-wide per-minute budget", async () => {
    const limiter = new SmartleadLimiter(2, 0, 20, 2, 40);
    const started: number[] = [];
    const job = () =>
      limiter.schedule(async () => {
        started.push(Date.now());
        return started.length;
      });
    await job();
    await job();
    const t0 = Date.now();
    await job();
    assert.ok(
      Date.now() - t0 >= 30,
      "a third call inside the window must wait for a slot",
    );
    assert.equal(started.length, 3);
    assert.equal(limiter.snapshot().maxPerMin, 2);
  });
});

