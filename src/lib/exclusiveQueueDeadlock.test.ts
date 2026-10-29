import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MutationQueue } from "./mutationQueue.js";
import {
  SmartleadLimiter,
  runAsQueuedJob,
  runInSmartleadLane,
} from "./smartleadLimiter.js";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * D318 — the health pass is exclusive on the limiter and waits on the serial
 * mutation queue; a normal-lane job at the head of that queue used to park
 * behind the exclusive lane, so neither could move until the job timeout.
 */
describe("D318 exclusive health lane vs the mutation queue", () => {
  it("a normal-lane queued job runs while health is exclusive; the health job behind it is not starved", async () => {
    const limiter = new SmartleadLimiter(2, 0, 50, 0);
    const queue = new MutationQueue(0, 50, 5_000);
    limiter.setExclusiveHealth(true);
    const order: string[] = [];

    const normalJob = runInSmartleadLane("normal", () =>
      queue.enqueue(() =>
        runAsQueuedJob(() =>
          limiter.schedule(async () => void order.push("normal"), { lane: "normal" }),
        ),
      ),
    );
    const healthJob = runInSmartleadLane("health", () =>
      queue.enqueue(() =>
        runAsQueuedJob(() =>
          limiter.schedule(async () => void order.push("health"), { lane: "health" }),
        ),
      ),
    );

    const done = await Promise.race([
      Promise.all([normalJob, healthJob]).then(() => true),
      tick(500).then(() => false),
    ]);
    assert.equal(done, true, "queue deadlocked behind the exclusive health lane");
    assert.deepEqual(order, ["normal", "health"]);
    assert.equal(limiter.snapshot().parkedBehindHealth, 0);
  });

  it("a normal-lane call that is NOT a queued job still waits behind exclusive health", async () => {
    const limiter = new SmartleadLimiter(2, 0, 50, 0);
    limiter.setExclusiveHealth(true);
    let ran = false;
    const normal = limiter.schedule(async () => {
      ran = true;
    });
    await tick(30);
    assert.equal(ran, false);
    assert.equal(limiter.snapshot().parkedBehindHealth, 1);
    limiter.setExclusiveHealth(false);
    await normal;
    assert.equal(ran, true);
  });
});
