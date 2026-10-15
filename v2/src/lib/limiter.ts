import {
  V2_SMARTLEAD_429_MAX_ATTEMPTS,
  V2_SMARTLEAD_CONCURRENCY,
  V2_SMARTLEAD_MAX_PER_MIN,
  V2_SMARTLEAD_MIN_GAP_MS,
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

function retryAfterFrom(error: unknown): number | undefined {
  return error instanceof RateLimitError ? error.retryAfterMs : undefined;
}

/**
 * D278 — v2's own Smartlead budget (20/min, concurrency 1), Postgres-shared
 * across staff + isolation so shadow cannot starve the old wizard (D257 150).
 * 429s release the slot, back off, and retry.
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
    private readonly concurrency = V2_SMARTLEAD_CONCURRENCY,
    private readonly maxPerMin = V2_SMARTLEAD_MAX_PER_MIN,
    private readonly minGapMs = V2_SMARTLEAD_MIN_GAP_MS,
    private readonly maxAttempts = V2_SMARTLEAD_429_MAX_ATTEMPTS,
  ) {}

  async schedule<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const pause = this.pausedUntil - Date.now();
      if (pause > 0) await sleep(pause);
      if (this.store) {
        await this.acquireShared();
      } else {
        await this.acquireLocal();
      }
      try {
        const gap = this.lastStartAt + this.minGapMs - Date.now();
        if (gap > 0) await sleep(gap);
        this.lastStartAt = Date.now();
        this.starts.push(this.lastStartAt);
        const value = await fn();
        this.streak = 0;
        return value;
      } catch (error) {
        lastError = error;
        if (isRateLimitError(error) && attempt < this.maxAttempts) {
          this.noteRateLimit(retryAfterFrom(error));
          continue;
        }
        throw error;
      } finally {
        if (this.store) await this.store.releaseRateSlot();
        else this.releaseLocal();
      }
    }
    throw lastError;
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
    concurrency: number;
  } {
    this.pruneStarts(Date.now());
    return {
      inflight: this.inflight,
      waiting: this.waiters.length,
      rateLimitStreak: this.streak,
      pausedForMs: Math.max(0, this.pausedUntil - Date.now()),
      requestsInWindow: this.starts.length,
      maxPerMin: this.maxPerMin,
      concurrency: this.concurrency,
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
