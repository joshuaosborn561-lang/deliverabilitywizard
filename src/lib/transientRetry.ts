/**
 * D265 — bounded retry with backoff for Slack one-tap spend / retire.
 * Transient only: HTTP 429, 5xx, fetch failed, timeout, reset.
 * Permanent errors throw on the first attempt.
 */

import { sleep } from "./http.js";

export const TAP_RETRY_ATTEMPTS = 3;
export const TAP_RETRY_BACKOFF_MS = [500, 1500, 3500] as const;

export function isTransientTapError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const status =
    typeof error === "object" && error && "status" in error
      ? Number((error as { status?: unknown }).status)
      : Number.NaN;
  if (status === 429 || (status >= 500 && status < 600)) return true;
  return (
    /\bHTTP\s*429\b/i.test(message) ||
    /\b429\b/.test(message) ||
    /rate[\s_-]*limit/i.test(message) ||
    /too many requests/i.test(message) ||
    /\bHTTP\s*5\d\d\b/i.test(message) ||
    /fetch failed/i.test(message) ||
    /networkerror|econnreset|econnrefused|enotfound|etimedout|socket/i.test(
      message,
    ) ||
    /timed?\s*out|timeout|operation was aborted|aborted/i.test(message)
  );
}

export async function withTransientRetry<T>(
  fn: () => Promise<T>,
  opts: {
    attempts?: number;
    backoffMs?: readonly number[];
    sleepFn?: (ms: number) => Promise<void>;
  } = {},
): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? TAP_RETRY_ATTEMPTS);
  const backoff = opts.backoffMs ?? TAP_RETRY_BACKOFF_MS;
  const pause = opts.sleepFn ?? sleep;
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isTransientTapError(error) || i === attempts - 1) throw error;
      await pause(backoff[Math.min(i, backoff.length - 1)] ?? 500);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
