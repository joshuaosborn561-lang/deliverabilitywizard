import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  abortableSleep,
  leaseIsStale,
  startTick,
  TickTimeoutError,
} from "./tickClock.js";

describe("D281 tick clock", () => {
  it("aborts after the timeout and names the hung step", async () => {
    const tick = startTick(30);
    tick.step("list_accounts");
    await abortableSleep(80).catch(() => undefined);
    assert.equal(tick.signal.aborted, true);
    assert.equal(tick.hungIn, "list_accounts");
    assert.ok(tick.signal.reason instanceof TickTimeoutError);
    assert.equal((tick.signal.reason as TickTimeoutError).hungIn, "list_accounts");
    tick.dispose();
  });

  it("abortableSleep rejects when the tick aborts", async () => {
    const tick = startTick(20);
    await assert.rejects(() => abortableSleep(200, tick.signal), TickTimeoutError);
    tick.dispose();
  });

  it("treats a missing or expired lease as stale", () => {
    const now = Date.parse("2026-10-16T00:00:00.000Z");
    assert.equal(leaseIsStale(null, 60_000, now), true);
    assert.equal(leaseIsStale("2026-10-15T23:50:00.000Z", 8 * 60_000, now), true);
    assert.equal(leaseIsStale("2026-10-15T23:59:00.000Z", 8 * 60_000, now), false);
  });
});
