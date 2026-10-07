/**
 * D247 — every watchdog stage races against a wall-clock budget so a
 * hung Smartlead / Slack / disk call cannot pin healthInFlight forever.
 *
 * Default 10 minutes. Inventory is 5 (shared-book fetch). campaign-check-first
 * and scan-backfill are 20 (they walk the board). The error string is
 * `timeout after Nm` so consecutiveFailures increments and D149 overdue
 * alerts fire.
 */

export const DEFAULT_STEP_TIMEOUT_MS = 10 * 60 * 1000;

export const STEP_TIMEOUT_MS: Record<string, number> = {
  inventory: 5 * 60 * 1000,
  "campaign-check-first": 20 * 60 * 1000,
  "scan-backfill": 20 * 60 * 1000,
};

export function stepTimeoutMs(name: string): number {
  return STEP_TIMEOUT_MS[name] ?? DEFAULT_STEP_TIMEOUT_MS;
}

/** `timeout after 10m` — minutes, matching the D247 error contract. */
export function timeoutAfterMessage(timeoutMs: number): string {
  const minutes = Math.max(1, Math.round(timeoutMs / 60_000));
  return `timeout after ${minutes}m`;
}

export function isStepTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /^timeout after \d+m$/.test(message);
}

/**
 * Race `work` against `timeoutMs`. The AbortSignal is aborted on timeout
 * so a step that accepts it can drop in-flight fetches. The race still
 * rejects with `timeout after Nm` even if the work ignores the signal.
 */
export async function raceStep<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const onParentAbort = (): void => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onParentAbort, { once: true });
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(timeoutAfterMessage(timeoutMs)));
    }, timeoutMs);
  });

  try {
    return await Promise.race([work(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", onParentAbort);
  }
}
