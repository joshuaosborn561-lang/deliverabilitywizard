/**
 * D131 — the registry of every stage the machine still runs, and how long
 * each may go without a success before the watchdog calls it OVERDUE.
 *
 * One blanket 45-minute window flagged the daily/6-hour stages as overdue
 * for most of every cycle (scan-backfill and mailbox-settings-full alarmed
 * all afternoon on 2026-08-26), which trains people to ignore the watchdog.
 * `null` marks an event-driven stage that runs only when something triggers
 * it — never overdue.
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
  "pod-cover": null, // D89 — runs only while an inbox lacks known-good coverage
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
  "isolation-buy-resume": SIX_HOURLY_MS,
  "canary-buy-resume": SIX_HOURLY_MS,
  "canary-adopt": SIX_HOURLY_MS,
  "isolation-rig": SIX_HOURLY_MS,
  "isolation-branch": SIX_HOURLY_MS,
  "copy-isolation": SIX_HOURLY_MS,
};
