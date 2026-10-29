import { AsyncResource } from "node:async_hooks";
import { sleep } from "./http.js";
import { raceStep, timeoutAfterMessage } from "./stepTimeout.js";

export const MUTATION_QUEUE_TIMEOUT_MS = 6 * 60 * 1000;

export interface MutationQueueSnapshot {
  depth: number;
  oldestWaitMs: number;
  rateLimitStreak: number;
}

/**
 * Serialise Smartlead (and similar) mutating writes so parallel crons / loops
 * do not stampede the API into 429s. Each job waits for the previous one, then
 * applies a minimum gap; failures that look like rate limits back off harder.
 * D247 — each queued call has a 6-minute timeout so a hung write cannot freeze
 * the chain (and every later health / monitor pass behind it).
 */
export class MutationQueue {
  private consecutiveRateLimits = 0;
  private waiting: Array<{
    enqueuedAt: number;
    critical: boolean;
    run: () => Promise<void>;
  }> = [];
  private runningStartedAt: number | null = null;
  private draining = false;

  constructor(
    private readonly minGapMs = 250,
    private readonly maxBackoffMs = 30_000,
    private readonly jobTimeoutMs = MUTATION_QUEUE_TIMEOUT_MS,
  ) {}

  /**
   * A1 (D312) — `critical` jobs (placement / test-reconcile / isolation
   * writes) go ahead of every queued non-critical write, FIFO among
   * themselves. A running job is never interrupted.
   */
  enqueue<T>(fn: () => Promise<T>, opts: { critical?: boolean } = {}): Promise<T> {
    // Run the job in the enqueuer's async context (lane, pass, stall scope),
    // not whichever caller happened to start the drain loop.
    const job = AsyncResource.bind(fn);
    return new Promise<T>((resolve, reject) => {
      const item = {
        enqueuedAt: Date.now(),
        critical: Boolean(opts.critical),
        run: async () => {
          this.runningStartedAt = Date.now();
          const backoff = this.rateLimitBackoffMs();
          if (backoff > 0) await sleep(backoff);
          try {
            const value = await raceStep(async () => job(), this.jobTimeoutMs);
            this.consecutiveRateLimits = 0;
            resolve(value);
          } catch (error) {
            if (looksLikeRateLimit(error)) {
              this.consecutiveRateLimits += 1;
            }
            reject(error);
          } finally {
            this.runningStartedAt = null;
            if (this.minGapMs > 0) await sleep(this.minGapMs);
          }
        },
      };
      if (item.critical) {
        const at = this.waiting.findIndex((row) => !row.critical);
        if (at < 0) this.waiting.push(item);
        else this.waiting.splice(at, 0, item);
      } else {
        this.waiting.push(item);
      }
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (let next = this.waiting.shift(); next; next = this.waiting.shift()) {
        await next.run();
      }
    } finally {
      this.draining = false;
    }
  }

  get depth(): number {
    return this.waiting.length + (this.runningStartedAt ? 1 : 0);
  }

  get oldestWaitMs(): number {
    const oldest = this.waiting[0]?.enqueuedAt ?? this.runningStartedAt;
    return oldest == null ? 0 : Date.now() - oldest;
  }

  /** Test helper — how many rate-limit failures are currently stacked. */
  get rateLimitStreak(): number {
    return this.consecutiveRateLimits;
  }

  snapshot(): MutationQueueSnapshot {
    return {
      depth: this.depth,
      oldestWaitMs: this.oldestWaitMs,
      rateLimitStreak: this.consecutiveRateLimits,
    };
  }

  private rateLimitBackoffMs(): number {
    if (this.consecutiveRateLimits <= 0) return 0;
    const base = Math.min(
      this.maxBackoffMs,
      1_000 * 2 ** Math.min(this.consecutiveRateLimits - 1, 5),
    );
    return base;
  }
}

function looksLikeRateLimit(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const status = (error as { status?: number }).status;
  if (status === 429) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /\b429\b|rate.?limit|too many requests/i.test(message);
}
