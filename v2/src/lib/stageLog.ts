import { STAGE_OVERDUE_MS } from "../canon/constants.js";
import type { StageStamp } from "../types.js";

/** One Railway line per successful stage — integers only. */
export function formatStageOkLog(
  stage: string,
  counts: Record<string, number | string | boolean | null | undefined>,
): string {
  const parts = Object.entries(counts)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`);
  return `[v2] ${stage} ok ${parts.join(" ")}`.trim();
}

export function stageIsOverdue(
  stamp: StageStamp,
  now = Date.now(),
  maxAgeMs = STAGE_OVERDUE_MS,
): boolean {
  const okAt = stamp.lastOkAt ? Date.parse(stamp.lastOkAt) : NaN;
  const errAt = stamp.lastErrorAt ? Date.parse(stamp.lastErrorAt) : NaN;
  if (stamp.lastError && (!Number.isFinite(okAt) || (Number.isFinite(errAt) && errAt >= okAt))) {
    return true;
  }
  if (!Number.isFinite(okAt)) return true;
  return now - okAt > maxAgeMs;
}

export function countKind(findings: readonly { kind: string }[], kind: string): number {
  return findings.filter((f) => f.kind === kind).length;
}

export function countIntendedKind(
  intended: readonly { kind: string }[],
  kind: string,
): number {
  return intended.filter((a) => a.kind === kind).length;
}
