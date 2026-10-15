/**
 * D270 — a monitor tick that cannot start because health is using the
 * Smartlead limiter must log why and retry after health ends. The D167
 * leftover resume used to fire the moment health finished *and* while
 * the next health cron still needed both limiter slots — test-reconcile
 * / campaign-audit then sat inFlight until their 10m timeout.
 */

export type MonitorSkipReason = "already-running" | "health-running";

export function monitorSkipReason(opts: {
  healthLive: boolean;
  alreadyRunning: boolean;
}): MonitorSkipReason | undefined {
  if (opts.alreadyRunning) return "already-running";
  if (opts.healthLive) return "health-running";
  return undefined;
}

export function monitorSkipLog(reason: MonitorSkipReason): string {
  if (reason === "health-running") {
    return "[monitor] Health pass running — skipping overlapping trigger; will retry after health (D270)";
  }
  return "[monitor] Already running — skipping overlapping trigger";
}

export function monitorShouldRetryAfterHealth(
  reason: MonitorSkipReason | undefined,
): boolean {
  return reason === "health-running";
}
