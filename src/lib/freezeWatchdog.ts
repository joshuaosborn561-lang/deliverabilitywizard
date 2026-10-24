/**
 * D247 / D257 / D265 / D271 — if the event loop stays blocked or a pass lock is
 * stuck past twice its max, set `process.exitCode = 1`, flush the lastOk
 * sidecar, then `process.exit(1)` so Railway restarts the service.
 * D257 also exits on repeated multi-second freezes (not only a single
 * freeze over 5 minutes). D265: never unref the interval (Node must not
 * drain to exit 0), never flush the full state dump, and Railway
 * restartPolicyType is ALWAYS so an unexpected 0 still comes back.
 * D271: every delay log names the in-flight stage plus a sampled stack
 * / async-hooks / perf_hooks attribution. Thresholds are not widened.
 */

import { executionAsyncId } from "node:async_hooks";
import type { InFlightLock } from "./inFlightLock.js";
import {
  freezeDelayLogLine,
  markWatchdogAsyncId,
  type StallLockStage,
} from "./eventLoopAttribution.js";

export const EVENT_LOOP_LOG_MS = 1_000;
export const EVENT_LOOP_EXIT_MS = 5 * 60 * 1000;
export const EVENT_LOOP_REPEAT_MS = 3_000;
export const EVENT_LOOP_REPEAT_COUNT = 3;
export const EVENT_LOOP_REPEAT_WINDOW_MS = 2 * 60 * 1000;
export const FREEZE_WATCHDOG_INTERVAL_MS = 5_000;
export const FREEZE_EXIT_CODE = 1;
export const FREEZE_EXIT_FLUSH_MS = 5_000;
export const FREEZE_EXIT_HARD_MS = 8_000;

export interface FreezeTickInput {
  now: number;
  lastBeatAt: number;
  intervalMs: number;
  eventLoopLogMs?: number;
  eventLoopExitMs?: number;
  eventLoopRepeatMs?: number;
  eventLoopRepeatCount?: number;
  eventLoopRepeatWindowMs?: number;
  recentFreezes?: number[];
  locks: Array<{
    name: string;
    stage?: string | null;
    since: number | null;
    maxMs: number;
  }>;
  /** D271 — already-formatted stage/op/stack line; built by the interval. */
  attribution?: string;
}

export interface FreezeTickResult {
  eventLoopDelayMs: number;
  lastBeatAt: number;
  recentFreezes: number[];
  log?: string;
  exitReason?: string;
}

export function freezeWatchdogTick(input: FreezeTickInput): FreezeTickResult {
  const intervalMs = input.intervalMs;
  const logMs = input.eventLoopLogMs ?? EVENT_LOOP_LOG_MS;
  const exitMs = input.eventLoopExitMs ?? EVENT_LOOP_EXIT_MS;
  const repeatMs = input.eventLoopRepeatMs ?? EVENT_LOOP_REPEAT_MS;
  const repeatCount = input.eventLoopRepeatCount ?? EVENT_LOOP_REPEAT_COUNT;
  const windowMs = input.eventLoopRepeatWindowMs ?? EVENT_LOOP_REPEAT_WINDOW_MS;
  const delay = Math.max(0, input.now - input.lastBeatAt - intervalMs);
  const gap = input.now - input.lastBeatAt;

  let log: string | undefined;
  let exitReason: string | undefined;

  if (delay >= logMs) {
    log = input.attribution
      ? `[watchdog] event-loop delay ${delay}ms ${input.attribution}`
      : freezeDelayLogLine(delay, input.locks as StallLockStage[]);
  }
  if (gap >= exitMs) {
    exitReason = `event loop blocked for ${Math.round(gap / 1000)}s`;
  }

  let recentFreezes = [...(input.recentFreezes ?? [])];
  if (delay >= repeatMs) {
    recentFreezes.push(input.now);
  }
  const cutoff = input.now - windowMs;
  recentFreezes = recentFreezes.filter((at) => at >= cutoff);
  if (!exitReason && recentFreezes.length >= repeatCount) {
    exitReason = `event loop delayed ${recentFreezes.length} times ≥${repeatMs}ms within ${Math.round(windowMs / 1000)}s`;
  }

  if (!exitReason) {
    for (const lock of input.locks) {
      if (lock.since == null) continue;
      const age = input.now - lock.since;
      if (age > lock.maxMs * 2) {
        exitReason = `${lock.name} pass stuck ${Math.round(age / 60000)}m (2× max ${Math.round(lock.maxMs / 60000)}m)`;
        break;
      }
    }
  }

  return {
    eventLoopDelayMs: delay,
    lastBeatAt: input.now,
    recentFreezes,
    log,
    exitReason,
  };
}

export interface FreezeExitDeps {
  reason: string;
  /**
   * D299 — persist the in-flight stage's freeze strike before the sidecar
   * flush. The flush is the part that timed out in production, so the
   * strike has to land first or the next boot still resumes there.
   */
  noteStrike?: () => void;
  flush?: () => Promise<void> | void;
  exit?: (code: number) => void;
  log?: (msg: string) => void;
  setExitCode?: (code: number) => void;
  flushMs?: number;
  hardKillMs?: number;
  wait?: (ms: number) => Promise<void>;
  scheduleHardKill?: (ms: number, fn: () => void) => () => void;
}

/**
 * D265 — stamp a non-zero exit code first so a later drain cannot look
 * like success, flush only the lastOk sidecar (never the full dump),
 * then `process.exit(1)`. A hung flush still exits 1; a hung exit is
 * SIGKILL'd.
 */
export async function requestFreezeExit(deps: FreezeExitDeps): Promise<void> {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const log = deps.log ?? ((msg: string) => console.warn(msg));
  const setExitCode =
    deps.setExitCode ??
    ((code: number) => {
      process.exitCode = code;
    });
  const flushMs = deps.flushMs ?? FREEZE_EXIT_FLUSH_MS;
  const hardKillMs = deps.hardKillMs ?? FREEZE_EXIT_HARD_MS;
  const wait =
    deps.wait ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
      }));
  const scheduleHardKill =
    deps.scheduleHardKill ??
    ((ms: number, fn: () => void) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    });

  if (deps.noteStrike) {
    try {
      deps.noteStrike();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log(`[watchdog] freeze-strike note failed (${detail})`);
    }
  }

  setExitCode(FREEZE_EXIT_CODE);
  log(
    `[watchdog] freeze — ${deps.reason}; flushing stamps then process.exit(${FREEZE_EXIT_CODE}) so Railway restarts`,
  );

  const cancelHardKill = scheduleHardKill(hardKillMs, () => {
    log(`[watchdog] process.exit hung after ${hardKillMs}ms; SIGKILL`);
    try {
      process.kill(process.pid, "SIGKILL");
    } catch {
      exit(FREEZE_EXIT_CODE);
    }
  });

  if (deps.flush) {
    try {
      let timedOut = false;
      await Promise.race([
        Promise.resolve().then(() => deps.flush!()),
        wait(flushMs).then(() => {
          timedOut = true;
        }),
      ]);
      if (timedOut) {
        log(
          `[watchdog] flush timed out after ${flushMs}ms; exiting ${FREEZE_EXIT_CODE}`,
        );
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log(`[watchdog] flush failed (${detail}); exiting ${FREEZE_EXIT_CODE}`);
    }
  }

  cancelHardKill();
  exit(FREEZE_EXIT_CODE);
}

export interface FreezeWatchdogDeps {
  now?: () => number;
  exit?: (code: number) => void;
  log?: (msg: string) => void;
  intervalMs?: number;
  noteStrike?: () => void;
  flush?: () => Promise<void> | void;
  flushMs?: number;
  setExitCode?: (code: number) => void;
  wait?: (ms: number) => Promise<void>;
  scheduleHardKill?: (ms: number, fn: () => void) => () => void;
  getLocks: () => InFlightLock[];
}

export function startFreezeWatchdog(deps: FreezeWatchdogDeps): { stop: () => void } {
  const now = deps.now ?? Date.now;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const log = deps.log ?? ((msg: string) => console.warn(msg));
  const intervalMs = deps.intervalMs ?? FREEZE_WATCHDOG_INTERVAL_MS;
  let lastBeatAt = now();
  let recentFreezes: number[] = [];
  let exiting = false;

  const interval = setInterval(() => {
    markWatchdogAsyncId(executionAsyncId());
    if (exiting) return;
    const locks = deps.getLocks().map((lock) => ({
      name: lock.name,
      stage: lock.stage,
      since: lock.since,
      maxMs: lock.maxMs,
    }));
    const tick = freezeWatchdogTick({
      now: now(),
      lastBeatAt,
      intervalMs,
      recentFreezes,
      locks,
    });
    lastBeatAt = tick.lastBeatAt;
    recentFreezes = tick.recentFreezes;
    if (tick.log) log(tick.log);
    if (tick.exitReason) {
      exiting = true;
      clearInterval(interval);
      void requestFreezeExit({
        reason: tick.exitReason,
        noteStrike: deps.noteStrike,
        flush: deps.flush,
        exit,
        log,
        setExitCode: deps.setExitCode,
        flushMs: deps.flushMs,
        wait: deps.wait,
        scheduleHardKill: deps.scheduleHardKill,
      });
    }
  }, intervalMs);
  // D265 — do not unref the interval. An unref'd handle lets Node drain
  // to exit 0 when other handles drop, and ON_FAILURE will not restart.

  return {
    stop: () => clearInterval(interval),
  };
}
