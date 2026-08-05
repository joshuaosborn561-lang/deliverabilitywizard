import { sleep } from "./http.js";

/**
 * Serialise Smartlead (and similar) mutating writes so parallel crons / loops
 * do not stampede the API into 429s. Each job waits for the previous one, then
 * applies a minimum gap; failures that look like rate limits back off harder.
 */
export class MutationQueue {
  private chain: Promise<unknown> = Promise.resolve();
  private consecutiveRateLimits = 0;

  constructor(
    private readonly minGapMs = 250,
    private readonly maxBackoffMs = 30_000,
  ) {}

  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      const backoff = this.rateLimitBackoffMs();
      if (backoff > 0) await sleep(backoff);
      try {
        const value = await fn();
        this.consecutiveRateLimits = 0;
        return value;
      } catch (error) {
        if (looksLikeRateLimit(error)) {
          this.consecutiveRateLimits += 1;
        }
        throw error;
      } finally {
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

  /** Test helper — how many rate-limit failures are currently stacked. */
  get rateLimitStreak(): number {
    return this.consecutiveRateLimits;
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
