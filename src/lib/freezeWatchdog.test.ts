import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EVENT_LOOP_EXIT_MS,
  EVENT_LOOP_LOG_MS,
  FREEZE_EXIT_CODE,
  freezeWatchdogTick,
  requestFreezeExit,
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
      locks: [{ name: "health", stage: "inventory", since: 1, maxMs: 1 }],
      attribution: "stage=health:inventory op=json.parseFile async=PROMISE stack=at parseFile",
    });
    assert.equal(logTick.eventLoopDelayMs, 5_000);
    assert.match(logTick.log ?? "", /event-loop delay 5000ms/);
    assert.match(logTick.log ?? "", /stage=health:inventory/);
    assert.match(logTick.log ?? "", /op=json.parseFile/);
    assert.match(logTick.log ?? "", /stack=at parseFile/);
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

  it("D257: exits on repeated multi-second freezes", () => {
    const first = freezeWatchdogTick({
      now: 10_000,
      lastBeatAt: 0,
      intervalMs: 5_000,
      locks: [],
    });
    assert.equal(first.recentFreezes.length, 1);
    assert.equal(first.exitReason, undefined);

    const second = freezeWatchdogTick({
      now: 20_000,
      lastBeatAt: 10_000,
      intervalMs: 5_000,
      recentFreezes: first.recentFreezes,
      locks: [],
    });
    assert.equal(second.recentFreezes.length, 2);
    assert.equal(second.exitReason, undefined);

    const third = freezeWatchdogTick({
      now: 30_000,
      lastBeatAt: 20_000,
      intervalMs: 5_000,
      recentFreezes: second.recentFreezes,
      locks: [],
    });
    assert.equal(third.recentFreezes.length, 3);
    assert.match(third.exitReason ?? "", /delayed 3 times/);
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
      setExitCode: () => undefined,
      log: (msg) => logs.push(msg),
      intervalMs: 10,
      getLocks: () => [lock],
      scheduleHardKill: () => () => undefined,
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

describe("D265 freeze-watchdog exit is non-zero after flush", () => {
  it("stamps exitCode 1, flushes, then process.exit(1)", async () => {
    const order: string[] = [];
    await requestFreezeExit({
      reason: "event loop blocked for 300s",
      setExitCode: (code) => {
        order.push(`exitCode=${code}`);
      },
      flush: () => {
        order.push("flush");
      },
      exit: (code) => {
        order.push(`exit=${code}`);
      },
      log: () => undefined,
      scheduleHardKill: () => () => undefined,
    });
    assert.deepEqual(order, [
      `exitCode=${FREEZE_EXIT_CODE}`,
      "flush",
      `exit=${FREEZE_EXIT_CODE}`,
    ]);
  });

  it("still exits 1 when flush hangs past the budget", async () => {
    const exits: number[] = [];
    const logs: string[] = [];
    await requestFreezeExit({
      reason: "health pass stuck 90m",
      setExitCode: () => undefined,
      flush: () => new Promise(() => undefined),
      exit: (code) => {
        exits.push(code);
      },
      log: (msg) => logs.push(msg),
      flushMs: 5,
      wait: () => Promise.resolve(),
      scheduleHardKill: () => () => undefined,
    });
    assert.deepEqual(exits, [1]);
    assert.ok(logs.some((line) => /flush timed out/.test(line)));
  });

  it("still exits 1 when flush throws", async () => {
    const exits: number[] = [];
    const logs: string[] = [];
    await requestFreezeExit({
      reason: "repeated freezes",
      setExitCode: () => undefined,
      flush: () => {
        throw new Error("disk full");
      },
      exit: (code) => {
        exits.push(code);
      },
      log: (msg) => logs.push(msg),
      scheduleHardKill: () => () => undefined,
    });
    assert.deepEqual(exits, [1]);
    assert.ok(logs.some((line) => /flush failed \(disk full\)/.test(line)));
  });

  it("startFreezeWatchdog flushes saveHot then exits 1 (never 0)", () => {
    const lock = new InFlightLock("health", HEALTH_LOCK_MAX_MS);
    assert.ok(lock.acquire("inventory", 0));

    const exits: number[] = [];
    const flushed: string[] = [];
    const codes: number[] = [];
    const watchdog = startFreezeWatchdog({
      now: () => HEALTH_LOCK_MAX_MS * 2 + 1,
      exit: (code) => {
        exits.push(code);
      },
      setExitCode: (code) => {
        codes.push(code);
      },
      flush: () => {
        flushed.push("saveHot");
      },
      log: () => undefined,
      intervalMs: 10,
      getLocks: () => [lock],
      scheduleHardKill: () => () => undefined,
    });

    return new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => {
        watchdog.stop();
        reject(new Error("watchdog did not flush-then-exit"));
      }, 200);
      const check = setInterval(() => {
        if (exits.length) {
          clearInterval(check);
          clearTimeout(deadline);
          watchdog.stop();
          try {
            assert.deepEqual(codes, [1]);
            assert.deepEqual(flushed, ["saveHot"]);
            assert.deepEqual(exits, [1]);
            resolve();
          } catch (error) {
            reject(error);
          }
        }
      }, 5);
    });
  });
});
