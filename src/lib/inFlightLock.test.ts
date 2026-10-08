import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HEALTH_LOCK_MAX_MS, InFlightLock } from "./inFlightLock.js";

describe("D247 stale-lock takeover", () => {
  it("skips acquire while the lock is live", () => {
    const lock = new InFlightLock("health", HEALTH_LOCK_MAX_MS);
    const first = lock.acquire("inventory", 1_000);
    assert.ok(first);
    assert.equal(first.takeover, false);
    assert.equal(lock.acquire("client-rest", 2_000), null);
    assert.equal(lock.owns(first.token), true);
    assert.deepEqual(lock.snapshot(), {
      since: new Date(1_000).toISOString(),
      stage: "inventory",
    });
  });

  it("takes over a stale lock with a new token; old release is a no-op", () => {
    const lock = new InFlightLock("health", 1_000);
    const old = lock.acquire("campaign-check-first", 0);
    assert.ok(old);
    lock.setStage(old.token, "campaign-check-first");

    const next = lock.acquire("starting", 1_001);
    assert.ok(next);
    assert.equal(next.takeover, true);
    assert.notEqual(next.token, old.token);
    assert.equal(lock.owns(old.token), false);
    assert.equal(lock.owns(next.token), true);
    assert.equal(lock.snapshot()?.stage, "starting");

    assert.equal(lock.release(old.token), false, "old pass must not clear the new owner");
    assert.equal(lock.held, true);
    assert.equal(lock.owns(next.token), true);

    lock.setStage(next.token, "inventory");
    assert.equal(lock.snapshot()?.stage, "inventory");
    assert.equal(lock.release(next.token), true);
    assert.equal(lock.held, false);
    assert.equal(lock.snapshot(), null);
  });
});
