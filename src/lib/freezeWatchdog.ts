/**
 * D247 — if the event loop stays blocked or a pass lock is stuck past
 * twice its max, `process.exit(1)` so Railway restarts the service.
 * Restart-on-failure must be on in Railway (see the PR).
 */

import type { InFlightLock } from "./inFlightLock.js";

export const EVENT_LOOP_LOG_MS = 1_000;
export const EVENT_LOOP_EXIT_MS = 5 * 60 * 1000;
export const FREEZE_WATCHDOG_INTERVAL_MS = 5_000;

export interface FreezeTickInput {
  now: number;
  lastBeatAt: number;
  intervalMs: number;
  eventLoopLogMs?: number;
  eventLoopExitMs?: number;
  locks: Array<{ name: string; since: number | null; maxMs: number }>;
}

export interface FreezeTickResult {
  eventLoopDelayMs: number;
  lastBeatAt: number;
  log?: string;
  exitReason?: string;
}

export function freezeWatchdogTick(input: FreezeTickInput): FreezeTickResult {
  const intervalMs = input.intervalMs;
  const logMs = input.eventLoopLogMs ?? EVENT_LOOP_LOG_MS;
  const exitMs = input.eventLoopExitMs ?? EVENT_LOOP_EXIT_MS;
  const delay = Math.max(0, input.now - input.lastBeatAt - intervalMs);
  const gap = input.now - input.lastBeatAt;

  let log: string | undefined;
  let exitReason: string | undefined;

  if (delay >= logMs) {
    log = `[watchdog] event-loop delay ${delay}ms`;
  }
  if (gap >= exitMs) {
    exitReason = `event loop blocked for ${Math.round(gap / 1000)}s`;
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
    log,
    exitReason,
  };
}

export interface FreezeWatchdogDeps {
  now?: () => number;
  exit?: (code: number) => void;
  log?: (msg: string) => void;
  intervalMs?: number;
  getLocks: () => InFlightLock[];
}

export function startFreezeWatchdog(deps: FreezeWatchdogDeps): { stop: () => void } {
  const now = deps.now ?? Date.now;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const log = deps.log ?? ((msg: string) => console.warn(msg));
  const intervalMs = deps.intervalMs ?? FREEZE_WATCHDOG_INTERVAL_MS;
  let lastBeatAt = now();

  const timer = setInterval(() => {
    const locks = deps.getLocks().map((lock) => ({
      name: lock.name,
      since: lock.since,
      maxMs: lock.maxMs,
    }));
    const tick = freezeWatchdogTick({
      now: now(),
      lastBeatAt,
      intervalMs,
      locks,
    });
    lastBeatAt = tick.lastBeatAt;
    if (tick.log) log(tick.log);
    if (tick.exitReason) {
      log(`[watchdog] freeze — ${tick.exitReason}; exiting so Railway restarts`);
      exit(1);
    }
  }, intervalMs);
  timer.unref?.();

  return {
    stop: () => clearInterval(timer),
  };
}
