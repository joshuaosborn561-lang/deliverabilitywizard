/**
 * D267 — a canon-ops every-30-minute tick that cannot start (health
 * pass in flight, process frozen, or already running) must log why
 * and retry after the blocker ends. node-cron does not replay a
 * missed fire after a freeze-restart (D249).
 */

export const CANON_OPS_CADENCE_MS = 30 * 60 * 1000;
export const CANON_OPS_OVERDUE_GRACE_MS = 2 * 60 * 1000;

export type CanonOpsSkipReason = "already-running" | "health-running";

export function canonOpsSkipReason(opts: {
  healthLive: boolean;
  alreadyRunning: boolean;
  /** D292 — hold/min40 lastOk older than cadence+grace. */
  overdue?: boolean;
}): CanonOpsSkipReason | undefined {
  if (opts.alreadyRunning) return "already-running";
  // A long or back-to-back health pass must not starve weekday
  // hold-enforcement / min40-topup past 30 minutes (D292). Fresh
  // ticks still yield to health (D267) and retry after it ends.
  if (opts.healthLive && !opts.overdue) return "health-running";
  return undefined;
}

export function canonOpsOverdueDespiteHealthLog(): string {
  return "[canon-ops] Health pass still running — starting overdue hold-enforcement/min40 anyway (D292)";
}

export function canonOpsSkipLog(reason: CanonOpsSkipReason): string {
  if (reason === "health-running") {
    return "[canon-ops] Health pass running — skipping overlapping trigger; will retry after health (D267)";
  }
  return "[canon-ops] Already running — skipping overlapping trigger";
}

export function canonOpsShouldRetryAfterHealth(
  reason: CanonOpsSkipReason | undefined,
): boolean {
  return reason === "health-running";
}

export function canonOpsTickOverdue(opts: {
  lastOkAt: string | null | undefined;
  now?: number;
  cadenceMs?: number;
  graceMs?: number;
}): boolean {
  if (!opts.lastOkAt) return true;
  const at = Date.parse(opts.lastOkAt);
  if (!Number.isFinite(at)) return true;
  const now = opts.now ?? Date.now();
  const cadence = opts.cadenceMs ?? CANON_OPS_CADENCE_MS;
  const grace = opts.graceMs ?? CANON_OPS_OVERDUE_GRACE_MS;
  return now - at > cadence + grace;
}
