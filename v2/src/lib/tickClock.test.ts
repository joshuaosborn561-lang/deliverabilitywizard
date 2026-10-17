import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  abortableSleep,
  capWaitMs,
  leaseIsStale,
  raceDeadline,
  startTick,
  TickTimeoutError,
  withTickDeadline,
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

describe("D284 hard deadline actually ends a hung await", () => {
  it("caps an 8h Retry-After to the remaining tick time", () => {
    const tick = startTick(80);
    assert.ok(capWaitMs(8 * 60 * 60 * 1000, tick.signal) <= 80);
    tick.dispose();
  });

  it("raceDeadline rejects a promise that ignores AbortSignal", async () => {
    const tick = startTick(40);
    const hung = new Promise<string>(() => undefined);
    const started = Date.now();
    await assert.rejects(() => raceDeadline(hung, tick.signal, "list_tests"), TickTimeoutError);
    assert.ok(Date.now() - started < 500);
    tick.dispose();
  });

  it("withTickDeadline returns even when work never settles", async () => {
    const tick = startTick(30);
    const started = Date.now();
    await assert.rejects(
      () => withTickDeadline(tick, new Promise(() => undefined), 20),
      TickTimeoutError,
    );
    assert.ok(Date.now() - started < 500);
    tick.dispose();
  });
});
