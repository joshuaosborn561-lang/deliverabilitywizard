import {
  V2_RATE_SLOT_TTL_MS,
  V2_SMARTLEAD_429_MAX_ATTEMPTS,
  V2_SMARTLEAD_CONCURRENCY,
  V2_SMARTLEAD_MAX_PER_MIN,
  V2_SMARTLEAD_MIN_GAP_MS,
} from "../canon/constants.js";
import { RateLimitError } from "../clients/http.js";
import {
  abortableSleep,
  capWaitMs,
  remainingFromSignal,
  throwIfAborted,
  TickTimeoutError,
} from "./tickClock.js";
import type { V2Store } from "../store.js";

export { RateLimitError };

export function isRateLimitError(error: unknown): boolean {
  if (error instanceof RateLimitError) return true;
  const text = String(error ?? "");
  return /\b429\b|rate.?limit/i.test(text);
}

function retryAfterFrom(error: unknown): number | undefined {
  return error instanceof RateLimitError ? error.retryAfterMs : undefined;
}

/** D284 — 429 backoff honors Retry-After but never past the tick deadline. */
export async function retryOn429<T>(
  fn: () => Promise<T>,
  signal?: AbortSignal,
  maxAttempts = V2_SMARTLEAD_429_MAX_ATTEMPTS,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    throwIfAborted(signal, "retry_429");
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRateLimitError(error) || attempt >= maxAttempts) throw error;
      const requested =
        retryAfterFrom(error) ?? Math.min(30_000, 1_000 * 2 ** Math.min(attempt - 1, 5));
      const wait = capWaitMs(requested, signal);
      if (wait <= 0) throw error;
      await abortableSleep(wait, signal);
      const leftover = requested - wait;
      if (leftover > 50) {
        throw new TickTimeoutError("retry_429", remainingFromSignal(signal) ?? wait);
      }
    }
  }
  throw lastError;
}

/**
 * D278/D284 — v2's own Smartlead budget (60/min token bucket, concurrency 1),
 * Postgres-shared across staff + isolation so shadow cannot starve the old
 * wizard (D257 150). 429s release the slot, honor Retry-After, and retry
 * only while the tick deadline remains.
 */
export class SharedSmartleadLimiter {
  private lastStartAt = 0;
  private streak = 0;
  private pausedUntil = 0;
  private starts: number[] = [];
  private inflight = 0;
  private waiters: Array<() => void> = [];
  private tokens: number;
  private lastRefill = Date.now();

  constructor(
    private readonly store?: V2Store,
    private readonly concurrency = V2_SMARTLEAD_CONCURRENCY,
    private readonly maxPerMin = V2_SMARTLEAD_MAX_PER_MIN,
    private readonly minGapMs = V2_SMARTLEAD_MIN_GAP_MS,
    private readonly maxAttempts = V2_SMARTLEAD_429_MAX_ATTEMPTS,
    private readonly slotTtlMs = V2_RATE_SLOT_TTL_MS,
  ) {
    this.tokens = maxPerMin;
  }

  async schedule<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      throwIfAborted(signal, "limiter");
      const pause = this.pausedUntil - Date.now();
      if (pause > 0) {
        const wait = capWaitMs(pause, signal);
        if (wait <= 0) {
          throw new TickTimeoutError("limiter_429", remainingFromSignal(signal) ?? 0);
        }
        await abortableSleep(wait, signal);
        if (this.pausedUntil - Date.now() > 50) {
          throw new TickTimeoutError("limiter_429", remainingFromSignal(signal) ?? wait);
        }
      }
      if (this.store) {
        await this.acquireShared(signal);
      } else {
        await this.acquireLocal(signal);
      }
      try {
        const gap = this.lastStartAt + this.minGapMs - Date.now();
        if (gap > 0) await abortableSleep(gap, signal);
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
    this.refillTokens();
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

  private refillTokens(now = Date.now()): void {
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.maxPerMin, this.tokens + (elapsed * this.maxPerMin) / 60_000);
    this.lastRefill = now;
  }

  private pruneStarts(now: number): void {
    const cutoff = now - 60_000;
    this.starts = this.starts.filter((at) => at >= cutoff);
  }

  private async acquireShared(signal?: AbortSignal): Promise<void> {
    for (;;) {
      throwIfAborted(signal, "limiter");
      const ok = await this.store!.acquireRateSlot(
        this.concurrency,
        this.maxPerMin,
        this.slotTtlMs,
      );
      if (ok) return;
      await abortableSleep(40, signal);
    }
  }

  private async acquireLocal(signal?: AbortSignal): Promise<void> {
    for (;;) {
      throwIfAborted(signal, "limiter");
      this.refillTokens();
      this.pruneStarts(Date.now());
      if (this.tokens < 1) {
        const wait = ((1 - this.tokens) * 60_000) / this.maxPerMin;
        if (wait > 0) await abortableSleep(wait, signal);
        continue;
      }
      if (this.inflight < this.concurrency) {
        this.tokens -= 1;
        this.inflight += 1;
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          const idx = this.waiters.indexOf(resolve);
          if (idx >= 0) this.waiters.splice(idx, 1);
          reject(
            signal?.reason instanceof Error
              ? signal.reason
              : new Error("limiter aborted"),
          );
        };
        if (signal?.aborted) {
          onAbort();
          return;
        }
        this.waiters.push(resolve);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
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
