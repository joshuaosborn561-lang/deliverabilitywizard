/**
 * D261 — a watchdog stage that starts must leave a stamp.
 *
 * Leftover / skip-if-fresh prefix skips never enter the stage (no stamp).
 * Once we decide to run — or we abandon because the pass was superseded —
 * lastOk or lastError must be written so /health cannot sit at an old
 * success with consecutiveFailures=0 and lastError null.
 *
 * D336 — the one exception is a `deferred` exit (a monitor walk that met a
 * live health pass): no stamp, so the D167 resume retries it after health
 * instead of a fake `timeout after 10m` or a 6-hour-fresh lastOk.
 */

export const STAGE_SILENT_EXIT = "exited without stamp";
export const STAGE_PASS_SUPERSEDED = "pass superseded";

export function finalizeStageStamp(opts: {
  stamped: boolean;
  name: string;
  recordError: (name: string, message: string) => void;
}): boolean {
  if (opts.stamped) return false;
  opts.recordError(opts.name, STAGE_SILENT_EXIT);
  return true;
}

export async function runStampedStage<T>(opts: {
  name: string;
  startedAt: number;
  run: () => Promise<T>;
  abandon?: () => string | null;
  idleReason?: (out: T) => string | undefined;
  recordOk: (name: string, durationMs: number, skipReason?: string) => void;
  recordError: (name: string, message: string) => void;
  checkpoint: (name: string) => Promise<void>;
  onError?: (error: unknown) => void;
  /**
   * D336 — an exit that is neither success nor failure (a monitor walk
   * that met a live health pass). Returns the log reason; nothing is
   * stamped so lastOk stays stale and the D167 resume retries the stage.
   */
  deferred?: (error: unknown) => string | null;
}): Promise<T | null> {
  const abandon = opts.abandon?.();
  if (abandon) {
    opts.recordError(opts.name, abandon);
    await opts.checkpoint(opts.name);
    return null;
  }

  let stamped = false;
  try {
    const out = await opts.run();
    opts.recordOk(
      opts.name,
      Date.now() - opts.startedAt,
      opts.idleReason?.(out),
    );
    stamped = true;
    await opts.checkpoint(opts.name);
    return out;
  } catch (error) {
    const deferred = opts.deferred?.(error);
    if (deferred) {
      console.log(
        `[watchdog] stage ${opts.name} deferred — ${deferred}; lastOk unchanged, resumes after health (D336)`,
      );
      stamped = true;
      return null;
    }
    const message = error instanceof Error ? error.message : String(error);
    opts.recordError(opts.name, message);
    stamped = true;
    opts.onError?.(error);
    await opts.checkpoint(opts.name);
    return null;
  } finally {
    if (finalizeStageStamp({ stamped, name: opts.name, recordError: opts.recordError })) {
      await opts.checkpoint(opts.name);
    }
  }
}
