import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApiError } from "./http.js";
import { SmartleadLimiter } from "./smartleadLimiter.js";
import {
  REPORT_BREAKER_FAILURES,
  ReportReadsPausedError,
  SmartDeliveryClient,
} from "../clients/smartdelivery.js";
import { rotateFrom } from "../services/resultMonitor.js";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("D319 limiter — normal lane keeps one share slot while health is exclusive", () => {
  it("a direct normal call runs under exclusive health when a slot beyond the last free one exists", async () => {
    const limiter = new SmartleadLimiter(2, 0, 50, 0);
    limiter.setExclusiveHealth(true);
    let ran = false;
    await limiter.schedule(async () => {
      ran = true;
    });
    assert.equal(ran, true, "normal lane starved by the exclusive health lane");
  });

  it("never takes the last free slot, and a second normal call waits for the share slot", async () => {
    const limiter = new SmartleadLimiter(2, 0, 50, 0);
    limiter.setExclusiveHealth(true);
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const first = limiter.schedule(async () => hold);
    await tick(5);
    let secondRan = false;
    const second = limiter.schedule(async () => {
      secondRan = true;
    });
    await tick(30);
    assert.equal(secondRan, false);
    // health still has its slot
    assert.equal(await limiter.schedule(async () => "h", { lane: "health" }), "h");
    release();
    await first;
    await second;
    assert.equal(secondRan, true, "parked normal call was never woken by the release");
  });
});

describe("D319 report-read budget", () => {
  function clientThatFails(status: number | undefined): {
    client: SmartDeliveryClient;
    calls: () => number;
  } {
    const client = new SmartDeliveryClient("k");
    let calls = 0;
    (client as unknown as { request: () => Promise<never> }).request = async () => {
      calls += 1;
      throw status === undefined ? new Error("network") : new ApiError("x", status, null);
    };
    return { client, calls: () => calls };
  }

  it("opens the breaker after repeated 429s; later reads fail fast without a request", async () => {
    const { client, calls } = clientThatFails(429);
    for (let i = 0; i < REPORT_BREAKER_FAILURES; i += 1) {
      await assert.rejects(client.getProviderwiseReport("1"));
    }
    assert.equal(client.reportReadsPaused(), true);
    const before = calls();
    await assert.rejects(client.getDomainBlacklist("2"), ReportReadsPausedError);
    assert.equal(calls(), before, "paused read still hit the network");
    assert.equal(client.reportParallelism(), 1);
  });

  it("a missing test (404) does not count against the breaker", async () => {
    const { client } = clientThatFails(404);
    for (let i = 0; i < REPORT_BREAKER_FAILURES + 2; i += 1) {
      await assert.rejects(client.getIpBlacklist("1"));
    }
    assert.equal(client.reportReadsPaused(), false);
  });

  it("caps request retries at one", async () => {
    const client = new SmartDeliveryClient("k");
    let seen: number | undefined;
    (client as unknown as { request: (p: string, o: { retries?: number }) => Promise<unknown> }).request =
      async (_p, o) => {
        seen = o.retries;
        return [];
      };
    await client.getProviderwiseReport("1", { retries: 4 });
    assert.equal(seen, 1);
    await client.getDomainBlacklist("1");
    assert.equal(seen, 1);
  });

  it("allows two parallel reads only with limiter headroom", () => {
    const limiter = new SmartleadLimiter(2, 0, 50, 150);
    const client = new SmartDeliveryClient("k", { limiter });
    assert.equal(client.reportParallelism(), 2);
    limiter.noteRateLimit(5_000);
    assert.equal(client.reportParallelism(), 1);
  });

  it("rotateFrom resumes at the cursor and wraps", () => {
    assert.deepEqual(rotateFrom([1, 2, 3, 4], 0), [1, 2, 3, 4]);
    assert.deepEqual(rotateFrom([1, 2, 3, 4], 2), [3, 4, 1, 2]);
    assert.deepEqual(rotateFrom([1, 2, 3, 4], 6), [3, 4, 1, 2]);
    assert.deepEqual(rotateFrom([], 3), []);
  });
});
