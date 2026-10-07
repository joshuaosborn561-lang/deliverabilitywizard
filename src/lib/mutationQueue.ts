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
  private chain: Promise<unknown> = Promise.resolve();
  private consecutiveRateLimits = 0;
  private waiting: { enqueuedAt: number }[] = [];
  private runningStartedAt: number | null = null;

  constructor(
    private readonly minGapMs = 250,
    private readonly maxBackoffMs = 30_000,
    private readonly jobTimeoutMs = MUTATION_QUEUE_TIMEOUT_MS,
  ) {}

  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const item = { enqueuedAt: Date.now() };
    this.waiting.push(item);
    const run = this.chain.then(async () => {
      this.waiting = this.waiting.filter((row) => row !== item);
      this.runningStartedAt = Date.now();
      const backoff = this.rateLimitBackoffMs();
      if (backoff > 0) await sleep(backoff);
      try {
        const value = await raceStep(async () => fn(), this.jobTimeoutMs);
        this.consecutiveRateLimits = 0;
        return value;
      } catch (error) {
        if (looksLikeRateLimit(error)) {
          this.consecutiveRateLimits += 1;
        }
        throw error;
      } finally {
        this.runningStartedAt = null;
        if (this.minGapMs > 0) await sleep(this.minGapMs);
      }
    });
    // Keep the chain alive even when a job fails.
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
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
