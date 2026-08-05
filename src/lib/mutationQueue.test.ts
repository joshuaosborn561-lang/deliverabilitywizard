import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MutationQueue } from "./mutationQueue.js";

describe("MutationQueue", () => {
  it("runs jobs serially", async () => {
    const queue = new MutationQueue(0);
    const order: number[] = [];
    const a = queue.enqueue(async () => {
      order.push(1);
      await new Promise((r) => setTimeout(r, 20));
      order.push(2);
      return "a";
    });
    const b = queue.enqueue(async () => {
      order.push(3);
      return "b";
    });
    assert.deepEqual(await Promise.all([a, b]), ["a", "b"]);
    assert.deepEqual(order, [1, 2, 3]);
  });

  it("keeps the chain alive after a failure", async () => {
    const queue = new MutationQueue(0);
    await assert.rejects(
      () => queue.enqueue(async () => {
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.equal(await queue.enqueue(async () => 7), 7);
  });

  it("tracks rate-limit streak from 429-shaped errors", async () => {
    const queue = new MutationQueue(0);
    await assert.rejects(() =>
      queue.enqueue(async () => {
        const err = new Error("429 rate limit") as Error & { status: number };
        err.status = 429;
        throw err;
      }),
    );
    assert.equal(queue.rateLimitStreak, 1);
    assert.equal(await queue.enqueue(async () => "ok"), "ok");
    assert.equal(queue.rateLimitStreak, 0);
  });
});
