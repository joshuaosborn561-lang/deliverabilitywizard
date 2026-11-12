/**
 * D336 — every 6-hour monitor stage stamps every sitting.
 *
 * pod-tags, pod-controls, the domain audits, the buy resumes, canary-adopt,
 * isolation-rig and copy-isolation used to sit inside `if (enable…)`
 * blocks. With ENABLE_POD_CONTROLS off they were never entered, never
 * stamped lastOk, and stayed D167 leftovers forever — so every 15-minute
 * health pass kicked another monitor resume sitting (prod 2026-11-12).
 * A disabled or testing-off stage now goes through `stage()` with an idle
 * body (`{ skipped, reason }`), the same shape canon-ops `runOrIdle` uses,
 * so `stageIdleReason` records lastOk + lastSkipReason. Idle bodies make
 * no Smartlead / SmartDelivery call.
 */

export type MonitorStageIdleReason = "disabled" | "testing-off";

export interface MonitorStageIdle {
  skipped: true;
  reason: MonitorStageIdleReason;
}

/**
 * Why a monitor stage idles this sitting, or null when it runs.
 * `testingGated` stages (canary-adopt, canary-buy-resume, isolation-rig,
 * copy-isolation) idle as `testing-off` while D333 testing is off, ahead
 * of their enable flag — that is the reason they would no-op anyway.
 */
export function monitorStageIdleReason(opts: {
  enabled: boolean;
  testingGated?: boolean;
  testingEnabled: boolean;
}): MonitorStageIdleReason | null {
  if (opts.testingGated && !opts.testingEnabled) return "testing-off";
  if (!opts.enabled) return "disabled";
  return null;
}

/** The stage body: the real run, or an idle stamp with no I/O. */
export function runOrIdleStage<T>(
  name: string,
  idle: MonitorStageIdleReason | null,
  run: (signal?: AbortSignal) => Promise<T>,
): (signal?: AbortSignal) => Promise<T | MonitorStageIdle> {
  if (idle) {
    return async () => {
      console.log(`[monitor] stage ${name} idle — ${idle} (D336)`);
      return { skipped: true, reason: idle };
    };
  }
  return run;
}

/**
 * D336 — the 90s canary-adopt boot kick (D86) is a direct call outside
 * `stage()`. With testing off (D333) it does nothing useful, so it is
 * not scheduled at all.
 */
export function shouldBootKickCanaryAdopt(opts: {
  secretsReady: boolean;
  testingEnabled: boolean;
}): boolean {
  return opts.secretsReady && opts.testingEnabled;
}
