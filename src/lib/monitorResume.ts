/**
 * D167 — the 6-hour monitor chain is resumable.
 *
 * `runMonitor` used to run every stage in one sitting and only persist
 * `lastOk` when a later writer happened to save. A Railway SIGTERM mid-chain
 * (deploy recycle, OOM) left the remaining stages at their morning stamp
 * until the next six-hour cron tick — a 6h+ D149 overdue cliff with
 * failures=0. lastOk of a finished stage is the checkpoint; a resume pass
 * skips anything still fresh inside the 6-hour cycle and continues from
 * the first stale name. The 6h cron still runs the full chain. Resume is
 * kicked from the 15-minute health tick, never at boot (D122).
 */

/** One monitor cycle — skip-if-fresh window. Not the 6h45m overdue grace. */
export const MONITOR_CYCLE_MS = 6 * 60 * 60 * 1000;

/**
 * Stages that live on the 6-hour `runMonitor` chain. warmup-gate also runs
 * here but is a 15-minute health stage (HEALTH_MS) — health keeps it fresh,
 * so a resume does not need to re-drive it.
 */
export const MONITOR_LOOP_STAGES = [
  "pod-tags",
  "monitor-results",
  "test-reconcile",
  "dns-audit",
  "campaign-audit",
  "lead-runout",
  "sending-infra",
  "pod-controls",
  "domain-client-audit",
  "domain-lifecycle",
  "isolation-buy-resume",
  "canary-buy-resume",
  "canary-adopt",
  "isolation-rig",
  "copy-isolation",
] as const;

export type MonitorLoopStage = (typeof MONITOR_LOOP_STAGES)[number];

export function isMonitorStageFresh(
  lastOkAt: string | null | undefined,
  now = Date.now(),
  freshMs = MONITOR_CYCLE_MS,
): boolean {
  if (!lastOkAt) return false;
  const at = Date.parse(lastOkAt);
  if (!Number.isFinite(at)) return false;
  return now - at <= freshMs;
}

export function staleMonitorStages(
  stageHealth: Record<string, { lastOkAt: string | null } | undefined>,
  now = Date.now(),
  freshMs = MONITOR_CYCLE_MS,
): MonitorLoopStage[] {
  return MONITOR_LOOP_STAGES.filter(
    (name) => !isMonitorStageFresh(stageHealth[name]?.lastOkAt, now, freshMs),
  );
}

export function monitorNeedsResume(
  stageHealth: Record<string, { lastOkAt: string | null } | undefined>,
  now = Date.now(),
  freshMs = MONITOR_CYCLE_MS,
): boolean {
  return staleMonitorStages(stageHealth, now, freshMs).length > 0;
}
