/**
 * D257 — one process-wide Smartlead request limiter. Inventory,
 * mailbox-settings, pod-controls, copy-canary, and campaign-check were
 * each firing in parallel and 429'ing the board. Every Smartlead HTTP
 * call (read or write) takes a concurrency slot; a 429 pauses the
 * whole limiter so later stages back off together.
 * D270 — a live health pass takes an exclusive lane so monitor /
 * campaign-audit cannot keep both slots and starve inventory.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { sleep } from "./http.js";

/**
 * A1 (D312) — "critical" is the top priority lane: placement results,
 * test-reconcile and isolation. It is never blocked by the exclusive health
 * lane and is served before health and normal waiters, so the sweep that
 * catches spam/placement problems keeps its cadence while a long health
 * pass is running.
 */
export type SmartleadLane = "critical" | "health" | "normal";

const laneStore = new AsyncLocalStorage<SmartleadLane>();
const queuedJobStore = new AsyncLocalStorage<boolean>();

/**
 * D318 — run `fn` as the body of a serialised mutation-queue job. The queue
 * runs one job at a time, so such a call can never hog both limiter slots;
 * and because every later queued job (the health pass's own reads and writes
 * included) waits behind it, it must NOT be parked behind the exclusive
 * health lane, which is waiting on that very queue.
 */
export function runAsQueuedJob<T>(fn: () => T): T {
  return queuedJobStore.run(true, fn);
}

export function runInSmartleadLane<T>(
  lane: SmartleadLane,
  fn: () => T,
): T {
  return laneStore.run(lane, fn);
}

export function smartleadLane(): SmartleadLane {
  return laneStore.getStore() ?? "normal";
}

export const SMARTLEAD_CONCURRENCY = 2;
export const SMARTLEAD_MIN_GAP_MS = 150;
export const SMARTLEAD_MAX_BACKOFF_MS = 30_000;
/**
 * Smartlead's account-wide cap is 200 requests / 1 minute (reads and
 * writes, including SmartDelivery). Stay comfortably under it so a
 * health pass + campaign-audit + isolation-branch cannot 429 the board.
 */
export const SMARTLEAD_MAX_PER_MIN = 150;
export const SMARTLEAD_RATE_WINDOW_MS = 60_000;

export interface SmartleadLimiterSnapshot {
  inflight: number;
  waiting: number;
  criticalWaiting: number;
  rateLimitStreak: number;
  pausedForMs: number;
  requestsInWindow: number;
  maxPerMin: number;
  exclusiveHealth: boolean;
  /** D318 — normal-lane calls parked behind the exclusive health lane. */
  parkedBehindHealth: number;
  /** D318 — health-lane calls waiting for a slot. */
  healthWaiting: number;
}

export class SmartleadLimiter {
  private inflight = 0;
  private waiters: Array<() => void> = [];
  private criticalWaiters: Array<() => void> = [];
  private healthWaiters: Array<() => void> = [];
  private backgroundWaiters: Array<() => void> = [];
  private exclusiveHealth = false;
  private pausedUntil = 0;
  private lastStartAt = 0;
  private streak = 0;
  private starts: number[] = [];

  constructor(
    private readonly concurrency = SMARTLEAD_CONCURRENCY,
    private readonly minGapMs = SMARTLEAD_MIN_GAP_MS,
    private readonly maxBackoffMs = SMARTLEAD_MAX_BACKOFF_MS,
    private readonly maxPerMin = SMARTLEAD_MAX_PER_MIN,
    private readonly rateWindowMs = SMARTLEAD_RATE_WINDOW_MS,
  ) {}

  setExclusiveHealth(on: boolean): void {
    this.exclusiveHealth = on;
    if (on) return;
    const pending = this.backgroundWaiters.splice(0);
    for (const wake of pending) wake();
  }

  async schedule<T>(
    fn: () => Promise<T>,
    opts: { lane?: SmartleadLane } = {},
  ): Promise<T> {
    await this.acquire(opts.lane ?? "normal");
    try {
      await this.waitPause();
      await this.waitRateWindow();
      const gap = this.lastStartAt + this.minGapMs - Date.now();
      if (gap > 0) await sleep(gap);
      this.lastStartAt = Date.now();
      this.starts.push(this.lastStartAt);
      const value = await fn();
      this.noteSuccess();
      return value;
    } finally {
      this.release();
    }
  }

  noteRateLimit(retryAfterMs?: number): void {
    this.streak += 1;
    const backoff =
      retryAfterMs ??
      Math.min(this.maxBackoffMs, 1_000 * 2 ** Math.min(this.streak - 1, 5));
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + backoff);
  }

  noteSuccess(): void {
    this.streak = 0;
  }

  snapshot(): SmartleadLimiterSnapshot {
    this.pruneStarts(Date.now());
    return {
      inflight: this.inflight,
      waiting: this.waiters.length,
      criticalWaiting: this.criticalWaiters.length,
      rateLimitStreak: this.streak,
      pausedForMs: Math.max(0, this.pausedUntil - Date.now()),
      requestsInWindow: this.starts.length,
      maxPerMin: this.maxPerMin,
      exclusiveHealth: this.exclusiveHealth,
      parkedBehindHealth: this.backgroundWaiters.length,
      healthWaiting: this.healthWaiters.length,
    };
  }

  private async acquire(requested: SmartleadLane): Promise<void> {
    // D318 — a queued write/read from a normal-lane caller used to park in
    // backgroundWaiters while the health pass (waiting on the same serial
    // queue) held the exclusive lane: nothing could move until the 6-minute
    // job timeout, three jobs deep. While health is exclusive, a queued job
    // rides the health lane instead (one job at a time, so one slot at most).
    const lane: SmartleadLane =
      this.exclusiveHealth && requested === "normal" && queuedJobStore.getStore()
        ? "health"
        : requested;
    for (;;) {
      if (this.exclusiveHealth && lane !== "health" && lane !== "critical") {
        await new Promise<void>((resolve) => {
          this.backgroundWaiters.push(resolve);
        });
        continue;
      }
      if (this.inflight < this.concurrency) {
        this.inflight += 1;
        return;
      }
      await new Promise<void>((resolve) => {
        if (lane === "critical") this.criticalWaiters.push(resolve);
        else if (lane === "health") this.healthWaiters.push(resolve);
        else this.waiters.push(resolve);
      });
      return;
    }
  }

  private release(): void {
    const critical = this.criticalWaiters.shift();
    if (critical) {
      critical();
      return;
    }
    if (this.exclusiveHealth) {
      const health = this.healthWaiters.shift();
      if (health) {
        health();
        return;
      }
      this.inflight = Math.max(0, this.inflight - 1);
      return;
    }
    const next = this.healthWaiters.shift() ?? this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.inflight = Math.max(0, this.inflight - 1);
    const background = this.backgroundWaiters.shift();
    background?.();
  }

  private async waitPause(): Promise<void> {
    const wait = this.pausedUntil - Date.now();
    if (wait > 0) await sleep(wait);
  }

  private pruneStarts(now: number): void {
    const cutoff = now - this.rateWindowMs;
    if (!this.starts.length || this.starts[0]! >= cutoff) return;
    this.starts = this.starts.filter((at) => at >= cutoff);
  }

  /** D267 — account-wide 200/min; we cap at 150 including SmartDelivery. */
  private async waitRateWindow(): Promise<void> {
    if (this.maxPerMin <= 0) return;
    for (;;) {
      const now = Date.now();
      this.pruneStarts(now);
      if (this.starts.length < this.maxPerMin) return;
      const wait = this.starts[0]! + this.rateWindowMs - now + 5;
      if (wait <= 0) return;
      await sleep(wait);
    }
  }
}
