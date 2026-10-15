import {
  SMARTLEAD_CONCURRENCY,
  SMARTLEAD_MAX_PER_MIN,
  SMARTLEAD_MIN_GAP_MS,
} from "../canon/constants.js";
import { RateLimitError } from "../clients/http.js";
import type { V2Store } from "../store.js";

export { RateLimitError };

export function isRateLimitError(error: unknown): boolean {
  if (error instanceof RateLimitError) return true;
  const text = String(error ?? "");
  return /\b429\b|rate.?limit/i.test(text);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * D257 — 150/min, concurrency 2. Memory for tests / ROLE=all;
 * Postgres-backed slots share the budget across staff + isolation.
 */
export class SharedSmartleadLimiter {
  private lastStartAt = 0;
  private streak = 0;
  private pausedUntil = 0;
  private starts: number[] = [];
  private inflight = 0;
  private waiters: Array<() => void> = [];

  constructor(
    private readonly store?: V2Store,
    private readonly concurrency = SMARTLEAD_CONCURRENCY,
    private readonly maxPerMin = SMARTLEAD_MAX_PER_MIN,
    private readonly minGapMs = SMARTLEAD_MIN_GAP_MS,
  ) {}

  async schedule<T>(fn: () => Promise<T>): Promise<T> {
    if (this.store) {
      await this.acquireShared();
    } else {
      await this.acquireLocal();
    }
    try {
      const pause = this.pausedUntil - Date.now();
      if (pause > 0) await sleep(pause);
      const gap = this.lastStartAt + this.minGapMs - Date.now();
      if (gap > 0) await sleep(gap);
      this.lastStartAt = Date.now();
      this.starts.push(this.lastStartAt);
      const value = await fn();
      this.streak = 0;
      return value;
    } catch (error) {
      if (isRateLimitError(error)) this.noteRateLimit();
      throw error;
    } finally {
      if (this.store) await this.store.releaseRateSlot();
      else this.releaseLocal();
    }
  }

  noteRateLimit(retryAfterMs?: number): void {
    this.streak += 1;
    const backoff = retryAfterMs ?? Math.min(30_000, 1_000 * 2 ** Math.min(this.streak - 1, 5));
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + backoff);
  }

  snapshot(): {
    inflight: number;
    waiting: number;
    rateLimitStreak: number;
    pausedForMs: number;
    requestsInWindow: number;
    maxPerMin: number;
  } {
    this.pruneStarts(Date.now());
    return {
      inflight: this.inflight,
      waiting: this.waiters.length,
      rateLimitStreak: this.streak,
      pausedForMs: Math.max(0, this.pausedUntil - Date.now()),
      requestsInWindow: this.starts.length,
      maxPerMin: this.maxPerMin,
    };
  }

  private pruneStarts(now: number): void {
    const cutoff = now - 60_000;
    this.starts = this.starts.filter((at) => at >= cutoff);
  }

  private async acquireShared(): Promise<void> {
    for (;;) {
      const ok = await this.store!.acquireRateSlot(this.concurrency, this.maxPerMin);
      if (ok) return;
      await sleep(40);
    }
  }

  private async acquireLocal(): Promise<void> {
    for (;;) {
      this.pruneStarts(Date.now());
      if (this.starts.length >= this.maxPerMin) {
        const wait = this.starts[0]! + 60_000 - Date.now() + 5;
        if (wait > 0) await sleep(wait);
        continue;
      }
      if (this.inflight < this.concurrency) {
        this.inflight += 1;
        return;
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  private releaseLocal(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.inflight = Math.max(0, this.inflight - 1);
  }
}
