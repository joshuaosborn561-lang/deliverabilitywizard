import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MutationQueue } from "./mutationQueue.js";
import { SmartleadLimiter, runInSmartleadLane, smartleadLane } from "./smartleadLimiter.js";
import { STAGE_OVERDUE_WINDOWS_MS, CRITICAL_SWEEP_OVERDUE_MS } from "./stageWindows.js";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("A1 critical lane — limiter", () => {
  it("a critical call is not blocked by the exclusive health lane; a normal call is", async () => {
    const limiter = new SmartleadLimiter(2, 0, 50, 0);
    limiter.setExclusiveHealth(true);
    // D319 — one slot is the normal lane's share; take the other with a health call.
    let releaseHealth!: () => void;
    const healthHold = new Promise<void>((r) => (releaseHealth = r));
    const healthCall = limiter.schedule(async () => healthHold, { lane: "health" });
    await tick(5);
    let normalRan = false;
    const normal = limiter.schedule(async () => {
      normalRan = true;
    });
    const critical = await limiter.schedule(async () => "ok", { lane: "critical" });
    assert.equal(critical, "ok");
    await tick(30);
    assert.equal(normalRan, false, "normal lane still waits behind exclusive health");
    releaseHealth();
    await healthCall;
    await normal;
    assert.equal(normalRan, true);
  });

  it("critical waiters are served before health and normal waiters", async () => {
    const limiter = new SmartleadLimiter(1, 0, 50, 0);
    const order: string[] = [];
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const first = limiter.schedule(async () => hold);
    await tick(5);
    const normal = limiter.schedule(async () => void order.push("normal"), { lane: "normal" });
    const health = limiter.schedule(async () => void order.push("health"), { lane: "health" });
    const critical = limiter.schedule(async () => void order.push("critical"), { lane: "critical" });
    release();
    await Promise.all([first, normal, health, critical]);
    assert.deepEqual(order, ["critical", "health", "normal"]);
  });

  it("the critical lane is visible inside runInSmartleadLane", () => {
    assert.equal(runInSmartleadLane("critical", () => smartleadLane()), "critical");
  });
});

describe("A1 critical lane — mutation queue", () => {
  it("critical writes jump ahead of queued normal writes, FIFO among themselves, and never interrupt the running one", async () => {
    const queue = new MutationQueue(0);
    const order: string[] = [];
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const running = queue.enqueue(async () => {
      order.push("running");
      await hold;
    });
    await tick(5);
    const n1 = queue.enqueue(async () => void order.push("n1"));
    const n2 = queue.enqueue(async () => void order.push("n2"));
    const c1 = queue.enqueue(async () => void order.push("c1"), { critical: true });
    const c2 = queue.enqueue(async () => void order.push("c2"), { critical: true });
    release();
    await Promise.all([running, n1, n2, c1, c2]);
    assert.deepEqual(order, ["running", "c1", "c2", "n1", "n2"]);
  });

  it("runs a job in the enqueuer's lane, not the drain starter's", async () => {
    const queue = new MutationQueue(0);
    const seen: string[] = [];
    const a = runInSmartleadLane("critical", () =>
      queue.enqueue(async () => {
        seen.push(smartleadLane());
        await tick(10);
      }),
    );
    const b = runInSmartleadLane("normal", () =>
      queue.enqueue(async () => void seen.push(smartleadLane())),
    );
    await Promise.all([a, b]);
    assert.deepEqual(seen, ["critical", "normal"]);
  });
});

describe("A1 critical stages cadence", () => {
  it("placement results, test-reconcile and isolation are overdue inside 75 minutes, not 6h45m", () => {
    assert.equal(STAGE_OVERDUE_WINDOWS_MS["monitor-results"], CRITICAL_SWEEP_OVERDUE_MS);
    assert.equal(STAGE_OVERDUE_WINDOWS_MS["test-reconcile"], CRITICAL_SWEEP_OVERDUE_MS);
    assert.ok(CRITICAL_SWEEP_OVERDUE_MS <= 75 * 60 * 1000);
    assert.ok((STAGE_OVERDUE_WINDOWS_MS["isolation-branch"] ?? 0) <= 45 * 60 * 1000);
  });
});
