/**
 * D257 — one process-wide Smartlead request limiter. Inventory,
 * mailbox-settings, pod-controls, copy-canary, and campaign-check were
 * each firing in parallel and 429'ing the board. Every Smartlead HTTP
 * call (read or write) takes a concurrency slot; a 429 pauses the
 * whole limiter so later stages back off together.
 */

import { sleep } from "./http.js";

export const SMARTLEAD_CONCURRENCY = 2;
export const SMARTLEAD_MIN_GAP_MS = 150;
export const SMARTLEAD_MAX_BACKOFF_MS = 30_000;

export interface SmartleadLimiterSnapshot {
  inflight: number;
  waiting: number;
  rateLimitStreak: number;
  pausedForMs: number;
}

export class SmartleadLimiter {
  private inflight = 0;
  private waiters: Array<() => void> = [];
  private pausedUntil = 0;
  private lastStartAt = 0;
  private streak = 0;

  constructor(
    private readonly concurrency = SMARTLEAD_CONCURRENCY,
    private readonly minGapMs = SMARTLEAD_MIN_GAP_MS,
    private readonly maxBackoffMs = SMARTLEAD_MAX_BACKOFF_MS,
  ) {}

  async schedule<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      await this.waitPause();
      const gap = this.lastStartAt + this.minGapMs - Date.now();
      if (gap > 0) await sleep(gap);
      this.lastStartAt = Date.now();
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
    return {
      inflight: this.inflight,
      waiting: this.waiters.length,
      rateLimitStreak: this.streak,
      pausedForMs: Math.max(0, this.pausedUntil - Date.now()),
    };
  }

  private async acquire(): Promise<void> {
    if (this.inflight < this.concurrency) {
      this.inflight += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.inflight = Math.max(0, this.inflight - 1);
  }

  private async waitPause(): Promise<void> {
    const wait = this.pausedUntil - Date.now();
    if (wait > 0) await sleep(wait);
  }
}
