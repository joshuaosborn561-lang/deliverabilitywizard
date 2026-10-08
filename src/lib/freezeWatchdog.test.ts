import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EVENT_LOOP_EXIT_MS,
  EVENT_LOOP_LOG_MS,
  freezeWatchdogTick,
  startFreezeWatchdog,
} from "./freezeWatchdog.js";
import { HEALTH_LOCK_MAX_MS, InFlightLock } from "./inFlightLock.js";

describe("D247 freeze watchdog", () => {
  it("exits on a pass stuck past twice its max via the tick helper", () => {
    const tick = freezeWatchdogTick({
      now: 90 * 60 * 1000 + 1,
      lastBeatAt: 90 * 60 * 1000,
      intervalMs: 5_000,
      locks: [{ name: "health", since: 0, maxMs: 45 * 60 * 1000 }],
    });
    assert.match(tick.exitReason ?? "", /health pass stuck/);
  });

  it("logs event-loop delay over 1s and exits after 5 min blocked", () => {
    const logTick = freezeWatchdogTick({
      now: 10_000,
      lastBeatAt: 0,
      intervalMs: 5_000,
      locks: [],
    });
    assert.equal(logTick.eventLoopDelayMs, 5_000);
    assert.match(logTick.log ?? "", /event-loop delay 5000ms/);
    assert.equal(logTick.exitReason, undefined);

    const exitTick = freezeWatchdogTick({
      now: EVENT_LOOP_EXIT_MS + 1,
      lastBeatAt: 0,
      intervalMs: 5_000,
      locks: [],
    });
    assert.ok(exitTick.eventLoopDelayMs >= EVENT_LOOP_LOG_MS);
    assert.match(exitTick.exitReason ?? "", /event loop blocked/);
  });

  it("exits when a pass is stuck past twice its max (mock exit)", () => {
    const lock = new InFlightLock("health", HEALTH_LOCK_MAX_MS);
    const acquired = lock.acquire("inventory", 0);
    assert.ok(acquired);

    const exits: number[] = [];
    const logs: string[] = [];
    let now = HEALTH_LOCK_MAX_MS * 2 + 1;
    const watchdog = startFreezeWatchdog({
      now: () => now,
      exit: (code) => {
        exits.push(code);
      },
      log: (msg) => logs.push(msg),
      intervalMs: 10,
      getLocks: () => [lock],
    });

    return new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => {
        watchdog.stop();
        reject(new Error("watchdog did not exit"));
      }, 200);
      const check = setInterval(() => {
        if (exits.length) {
          clearInterval(check);
          clearTimeout(deadline);
          watchdog.stop();
          try {
            assert.deepEqual(exits, [1]);
            assert.ok(logs.some((line) => /health pass stuck/.test(line)));
            resolve();
          } catch (error) {
            reject(error);
          }
        }
      }, 5);
    });
  });
});
