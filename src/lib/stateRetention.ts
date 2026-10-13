/**
 * D257 — prune ledgers and finding history before the full state dump.
 * `/data/state.json` grew to ~110MB; compact stringify of that blob
 * froze the event loop for seconds and the load parse for much longer.
 * Caps are retention, not behaviour: live holds, pending asks, and
 * current campaign-check findings stay.
 */

import type { AppState } from "../state/store.js";

const DAY = 24 * 60 * 60 * 1000;

export const STATE_RETENTION = {
  alertedKeysMs: 14 * DAY,
  remediatedKeysMs: 14 * DAY,
  resurrectedLeadsMs: 45 * DAY,
  bounceSnapshotsMs: 14 * DAY,
  bounceVerdictsMs: 30 * DAY,
  bouncePausedMs: 180 * DAY,
  warmupEnsuredMs: 14 * DAY,
  deliverabilityDecisionsMs: 90 * DAY,
  isolationRunsMs: 90 * DAY,
  isolationVariantsMs: 90 * DAY,
  isolationActionsSettledMs: 90 * DAY,
  placementScoresMs: 14 * DAY,
  copySuspectsMs: 90 * DAY,
  bugRemediationResolvedMs: 30 * DAY,
  terlPausedDaysKeep: 14,
  mailboxHistoryCap: 8,
  domainReadingsCap: 8,
  opsAuditCap: 500,
  maxAlertedKeys: 2_000,
  maxRemediatedKeys: 2_000,
  maxResurrectedLeads: 5_000,
  maxIsolationRuns: 120,
  maxIsolationVariants: 200,
  maxPlacementScores: 400,
} as const;

export interface PruneStats {
  dropped: number;
}

function pruneIsoRecord(
  record: Record<string, string>,
  now: number,
  maxAgeMs: number,
  cap: number,
): number {
  let dropped = 0;
  const kept: Array<[string, number]> = [];
  for (const [key, iso] of Object.entries(record)) {
    const at = Date.parse(iso);
    if (!Number.isFinite(at) || now - at > maxAgeMs) {
      delete record[key];
      dropped += 1;
    } else {
      kept.push([key, at]);
    }
  }
  if (kept.length > cap) {
    kept.sort((a, b) => a[1] - b[1]);
    const extra = kept.length - cap;
    for (let i = 0; i < extra; i += 1) {
      delete record[kept[i]![0]];
      dropped += 1;
    }
  }
  return dropped;
}

function pruneByAt<T>(
  record: Record<string, T>,
  now: number,
  maxAgeMs: number,
  atOf: (row: T) => string | undefined,
  cap: number,
): number {
  let dropped = 0;
  const kept: Array<[string, number]> = [];
  for (const [key, row] of Object.entries(record)) {
    const at = Date.parse(atOf(row) ?? "");
    if (!Number.isFinite(at) || now - at > maxAgeMs) {
      delete record[key];
      dropped += 1;
    } else {
      kept.push([key, at]);
    }
  }
  if (kept.length > cap) {
    kept.sort((a, b) => a[1] - b[1]);
    const extra = kept.length - cap;
    for (let i = 0; i < extra; i += 1) {
      delete record[kept[i]![0]];
      dropped += 1;
    }
  }
  return dropped;
}

function capArray<T>(list: T[] | undefined, cap: number): number {
  if (!list || list.length <= cap) return 0;
  const extra = list.length - cap;
  list.splice(0, extra);
  return extra;
}

function ymdAgeDays(ymd: string, now: Date): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!match) return null;
  const then = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Math.floor((now.getTime() - then) / DAY);
}

/** Mutates `state` in place. Safe to call on every save and after load. */
export function pruneStateLedgers(state: AppState, now = Date.now()): PruneStats {
  let dropped = 0;
  const when = new Date(now);

  dropped += pruneIsoRecord(
    state.alertedKeys,
    now,
    STATE_RETENTION.alertedKeysMs,
    STATE_RETENTION.maxAlertedKeys,
  );
  dropped += pruneIsoRecord(
    state.remediatedKeys,
    now,
    STATE_RETENTION.remediatedKeysMs,
    STATE_RETENTION.maxRemediatedKeys,
  );
  dropped += pruneIsoRecord(
    state.resurrectedLeads,
    now,
    STATE_RETENTION.resurrectedLeadsMs,
    STATE_RETENTION.maxResurrectedLeads,
  );
  dropped += pruneIsoRecord(
    state.bouncePausedCampaigns,
    now,
    STATE_RETENTION.bouncePausedMs,
    500,
  );
  dropped += pruneIsoRecord(
    state.warmupEnsuredAt,
    now,
    STATE_RETENTION.warmupEnsuredMs,
    2_000,
  );

  dropped += pruneByAt(
    state.bounceSnapshots,
    now,
    STATE_RETENTION.bounceSnapshotsMs,
    (row) => row.at,
    500,
  );
  dropped += pruneByAt(
    state.bounceVerdicts,
    now,
    STATE_RETENTION.bounceVerdictsMs,
    (row) => row.at,
    500,
  );
  dropped += pruneByAt(
    state.deliverabilityDecisions,
    now,
    STATE_RETENTION.deliverabilityDecisionsMs,
    (row) => row.decidedAt,
    400,
  );
  dropped += pruneByAt(
    state.isolation.runs,
    now,
    STATE_RETENTION.isolationRunsMs,
    (row) => row.updatedAt ?? row.startedAt,
    STATE_RETENTION.maxIsolationRuns,
  );
  dropped += pruneByAt(
    state.isolation.variants,
    now,
    STATE_RETENTION.isolationVariantsMs,
    (row) => row.createdAt,
    STATE_RETENTION.maxIsolationVariants,
  );
  dropped += pruneByAt(
    state.isolation.placementScores,
    now,
    STATE_RETENTION.placementScoresMs,
    (row) => row.at,
    STATE_RETENTION.maxPlacementScores,
  );
  dropped += pruneByAt(
    state.isolation.copySuspects,
    now,
    STATE_RETENTION.copySuspectsMs,
    (row) => row.evaluatedAt ?? row.at,
    400,
  );

  for (const [id, action] of Object.entries(state.isolation.actions)) {
    if (action.status === "pending" || action.status === "approved") continue;
    const at = Date.parse(action.executedAt ?? action.decidedAt ?? action.requestedAt);
    if (!Number.isFinite(at) || now - at > STATE_RETENTION.isolationActionsSettledMs) {
      delete state.isolation.actions[id];
      dropped += 1;
    }
  }

  for (const [email, row] of Object.entries(state.isolation.mailboxResults)) {
    dropped += capArray(row.history, STATE_RETENTION.mailboxHistoryCap);
    if (!row.email) delete state.isolation.mailboxResults[email];
  }
  for (const row of Object.values(state.isolation.domainHistory)) {
    dropped += capArray(row.readings, STATE_RETENTION.domainReadingsCap);
  }

  for (const [ymd] of Object.entries(state.terlPausedDays)) {
    const age = ymdAgeDays(ymd, when);
    if (age != null && age > STATE_RETENTION.terlPausedDaysKeep) {
      delete state.terlPausedDays[ymd];
      dropped += 1;
    }
  }

  for (const [key, row] of Object.entries(state.bugRemediations)) {
    if (row.status !== "resolved" && row.status !== "ignored") continue;
    const at = Date.parse(row.lastSeenAt ?? row.firstSeenAt);
    if (!Number.isFinite(at) || now - at > STATE_RETENTION.bugRemediationResolvedMs) {
      delete state.bugRemediations[key];
      dropped += 1;
    }
  }

  if (state.opsAudit.length > STATE_RETENTION.opsAuditCap) {
    dropped += state.opsAudit.length - STATE_RETENTION.opsAuditCap;
    state.opsAudit.splice(0, state.opsAudit.length - STATE_RETENTION.opsAuditCap);
  }

  return { dropped };
}
