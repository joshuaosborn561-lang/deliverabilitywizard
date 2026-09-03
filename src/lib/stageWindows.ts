/**
 * D131 — the registry of every stage the machine still runs, and how long
 * each may go without a success before the watchdog calls it OVERDUE.
 *
 * One blanket 45-minute window flagged the daily/6-hour stages as overdue
 * for most of every cycle (scan-backfill and mailbox-settings-full alarmed
 * all afternoon on 2026-08-26), which trains people to ignore the watchdog.
 * `null` marks an event-driven stage that runs only when something triggers
 * it — never overdue. D166: `pod-cover` ticks every health pass (idle is a
 * success) so its window is the 15-minute sweep, not null. A six-day frozen
 * lastOkAt with consecutiveFailures=0 was silent green on production.
 *
 * This map is also the prune list: a persisted stageHealth record whose
 * name is missing here belongs to a stage the code no longer has, and is
 * dropped at boot — a deleted stage must not alarm forever from its ghost
 * record. The D131 guard (src/guards/canon.test.ts) fails the suite if a `stage("…")`
 * call in index.ts is missing from this map.
 */

/** 15-minute canon-sweep cadence plus grace for a long pass. */
const HEALTH_MS = 45 * 60 * 1000;
/** 6-hour cadence (monitor loop, full mailbox-settings converge) plus grace. */
const SIX_HOURLY_MS = (6 * 60 + 45) * 60 * 1000;

/** Fallback for a stage that runs but is missing from the registry below. */
export const STAGE_FALLBACK_OVERDUE_MS = 45 * 60 * 1000;

export interface OverdueStage {
  name: string;
  lastOkAt: string | null;
  consecutiveFailures: number;
  lastError: string | null;
  windowMs: number;
}

export interface StageHealthRow {
  lastOkAt: string | null;
  consecutiveFailures: number;
  lastError: string | null;
  lastSkipReason?: string | null;
}

/** Shape `/health` publishes for one stage (D84 + overdue bit, D166). */
export interface StageHealthView {
  lastOkAt: string | null;
  consecutiveFailures: number;
  lastError: string | null;
  overdue: boolean;
  lastSkipReason: string | null;
}

/**
 * D131/D149 — the one place "overdue" is judged, shared by the log
 * scoreboard and the Slack pager so the two can never disagree. An
 * event-driven stage (window null) is never overdue.
 */
export function overdueStages(
  stageHealth: Record<string, StageHealthRow>,
  now = Date.now(),
): OverdueStage[] {
  const out: OverdueStage[] = [];
  for (const [name, row] of Object.entries(stageHealth)) {
    const windowMs =
      name in STAGE_OVERDUE_WINDOWS_MS
        ? STAGE_OVERDUE_WINDOWS_MS[name]
        : STAGE_FALLBACK_OVERDUE_MS;
    if (windowMs == null) continue;
    const lastOk = row.lastOkAt ? Date.parse(row.lastOkAt) : null;
    if (lastOk == null || now - lastOk > windowMs) {
      out.push({
        name,
        lastOkAt: row.lastOkAt,
        consecutiveFailures: row.consecutiveFailures,
        lastError: row.lastError,
        windowMs,
      });
    }
  }
  return out;
}

/**
 * D166 — `/health` names overdue stages instead of leaving a six-day
 * lastOkAt next to consecutiveFailures=0 for a human to notice.
 */
export function stageHealthView(
  stageHealth: Record<string, StageHealthRow>,
  now = Date.now(),
): {
  stages: Record<string, StageHealthView>;
  overdueStages: OverdueStage[];
} {
  const overdue = overdueStages(stageHealth, now);
  const overdueNames = new Set(overdue.map((row) => row.name));
  const stages: Record<string, StageHealthView> = {};
  for (const [name, row] of Object.entries(stageHealth)) {
    stages[name] = {
      lastOkAt: row.lastOkAt,
      consecutiveFailures: row.consecutiveFailures,
      lastError: row.consecutiveFailures > 0 ? row.lastError : null,
      overdue: overdueNames.has(name),
      lastSkipReason: row.lastSkipReason ?? null,
    };
  }
  return { stages, overdueStages: overdue };
}

/** Idle tick from `stage()` — lastOkAt refreshes, SmartDelivery work does not. */
export function stageIdleReason(out: unknown): string | undefined {
  if (!out || typeof out !== "object") return undefined;
  const rec = out as { skipped?: unknown; reason?: unknown };
  if (rec.skipped === true && typeof rec.reason === "string" && rec.reason) {
    return rec.reason;
  }
  return undefined;
}

export const STAGE_OVERDUE_WINDOWS_MS: Record<string, number | null> = {
  // Canon sweep — every 15 minutes (D84).
  // Umbrella record for the whole pass (recorded directly at the end of
  // runHealth, not through stage()) — "a full pass completed end-to-end".
  "health-pass": HEALTH_MS,
  inventory: HEALTH_MS,
  reconnect: HEALTH_MS,
  "client-rest": HEALTH_MS,
  "generic-rest": HEALTH_MS,
  "warmup-gate": HEALTH_MS, // also re-run by the monitor; shares this key
  "client-tag": HEALTH_MS,
  "one-client": HEALTH_MS,
  "qa-unpause": HEALTH_MS,
  "campaign-check-first": HEALTH_MS,
  "campaign-health": HEALTH_MS,
  "pod-cover": HEALTH_MS, // D166 — watchdog tick every health pass; work still D89-gated
  "mailbox-gap": HEALTH_MS,
  // Slower converges piggybacked on the sweep.
  "mailbox-settings-full": SIX_HOURLY_MS,
  "scan-backfill": null, // D116 — runs only when a placement test is missing
  // Monitor loop — every 6 hours (D131).
  "monitor-results": SIX_HOURLY_MS,
  "test-reconcile": SIX_HOURLY_MS,
  "dns-audit": SIX_HOURLY_MS,
  "campaign-audit": SIX_HOURLY_MS,
  "lead-runout": SIX_HOURLY_MS,
  "sending-infra": SIX_HOURLY_MS,
  "pod-controls": SIX_HOURLY_MS,
  "pod-tags": SIX_HOURLY_MS,
  "domain-client-audit": SIX_HOURLY_MS,
  "domain-lifecycle": SIX_HOURLY_MS,
  "isolation-buy-resume": HEALTH_MS, // D174 — retry a failed post-pull buy every sweep
  "canary-buy-resume": SIX_HOURLY_MS,
  "canary-adopt": SIX_HOURLY_MS,
  "isolation-rig": SIX_HOURLY_MS,
  // D159 — score→suspect→evaluate rides the 15-minute health sweep.
  "isolation-branch": HEALTH_MS,
  "copy-isolation": SIX_HOURLY_MS,
};
