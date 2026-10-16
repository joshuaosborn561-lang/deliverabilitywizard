import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryStore } from "../store.js";

describe("D281 in-flight tick lease", () => {
  it("rejects a second acquire until TTL expiry or release", async () => {
    const store = new MemoryStore();
    const first = await store.acquireTickLease("staff", 50);
    assert.equal(first.acquired, true);
    const second = await store.acquireTickLease("staff", 50);
    assert.equal(second.acquired, false);
    await store.releaseTickLease("staff");
    const third = await store.acquireTickLease("staff", 50);
    assert.equal(third.acquired, true);
  });

  it("clears a stale lease so a crashed worker cannot block forever", async () => {
    const store = new MemoryStore();
    await store.acquireTickLease("isolation", 20, new Date("2026-10-15T18:00:00.000Z"));
    const n = await store.expireStaleTickLeases(20, new Date("2026-10-15T18:00:01.000Z"));
    assert.equal(n, 1);
    const next = await store.acquireTickLease("isolation", 20);
    assert.equal(next.acquired, true);
  });

  it("boot release of this role unsticks a hung in-process tick", async () => {
    const store = new MemoryStore();
    await store.acquireTickLease("staff", 10 * 60_000);
    await store.releaseTickLease("staff");
    const next = await store.acquireTickLease("staff", 10 * 60_000);
    assert.equal(next.acquired, true);
  });
});
