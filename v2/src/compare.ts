import { CANON_CORE_KINDS } from "./canon/constants.js";
import type { EspInboxDay, Finding, IntendedAction, OldWizardHealth, PlacementScore, QaRun } from "./types.js";

export interface ComparisonReport {
  at: string;
  old: {
    canonCompliant?: boolean;
    canonFindings: Record<string, number>;
    uglyWithoutIsolation: number;
    uglyCampaignIds: number[];
  };
  v2: {
    canonCompliant: boolean;
    canonFindings: Record<string, number>;
    uglyWithoutIsolation: number;
    uglyCampaignIds: number[];
    intended: Record<string, number>;
  };
  diff: {
    findingsOnlyInOld: string[];
    findingsOnlyInV2: string[];
    uglyOnlyInOld: number[];
    uglyOnlyInV2: number[];
    intendedAttaches: number;
    intendedDetaches: number;
    intendedIsolations: number;
    intendedTests: number;
    intendedWordHunts: number;
    intendedReconnects: number;
  };
  espInboxRates: EspInboxDay[];
  qa: { scheduled: number; completed: number; missed: number };
  notes: string[];
}

export const COMPARE_ALWAYS_KINDS = [
  "understaffed",
  "esp_mix",
  "generic_idle",
  "below_launch_bar",
  "missing_signature_tag",
  "esp_matching",
  "plain_text",
  "send_window",
  "ugly_without_isolation",
] as const;

export function countKinds(findings: Finding[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of findings) {
    out[f.kind] = (out[f.kind] ?? 0) + 1;
  }
  return out;
}

export function zeroFillKinds(
  counts: Record<string, number>,
  keys: readonly string[] = COMPARE_ALWAYS_KINDS,
): Record<string, number> {
  const out = { ...counts };
  for (const key of keys) {
    if (out[key] == null) out[key] = 0;
  }
  return out;
}

export function countIntended(actions: IntendedAction[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of actions) {
    out[a.kind] = (out[a.kind] ?? 0) + 1;
  }
  return out;
}

export function canonCompliantFromFindings(findings: Finding[]): boolean {
  return !findings.some((f) => (CANON_CORE_KINDS as readonly string[]).includes(f.kind));
}

export function buildComparison(opts: {
  old?: OldWizardHealth | null;
  findings: Finding[];
  intended: IntendedAction[];
  scores: PlacementScore[];
  espInboxRates?: EspInboxDay[];
  qaRuns?: QaRun[];
  now?: Date;
}): ComparisonReport {
  const v2Counts = zeroFillKinds(countKinds(opts.findings));
  const oldCounts = zeroFillKinds(opts.old?.canonFindings ?? {});
  const oldUgly = opts.old?.placementIsolation?.uglyWithoutIsolation ?? [];
  const oldUglyIds = oldUgly.map((r) => r.campaignId);
  const v2Ugly = opts.findings.filter((f) => f.kind === "ugly_without_isolation");
  const v2UglyIds = v2Ugly.map((f) => f.campaignId).filter((n): n is number => n != null);
  const intended = countIntended(opts.intended);

  const findingsOnlyInOld = Object.keys(oldCounts).filter(
    (k) => (oldCounts[k] ?? 0) > 0 && (v2Counts[k] ?? 0) === 0,
  );
  const findingsOnlyInV2 = Object.keys(v2Counts).filter(
    (k) => (v2Counts[k] ?? 0) > 0 && (oldCounts[k] ?? 0) === 0,
  );

  const notes: string[] = [];
  if ((v2Counts.isolation_deadline ?? 0) > 0) {
    notes.push("v2 has isolation_deadline holes the old wizard does not track as a 30m clock.");
  }
  if ((v2Counts.duplicate_canary_test ?? 0) > 0) {
    notes.push("v2 found duplicate Canary copy tests.");
  }
  if (oldUglyIds.length && v2UglyIds.length === 0) {
    notes.push(
      `Old wizard still lists 0% uglyWithoutIsolation; v2 has not scored copy-canary for ${oldUglyIds.join(",")}.`,
    );
  }

  return {
    at: (opts.now ?? new Date()).toISOString(),
    old: {
      canonCompliant: opts.old?.canonCompliant,
      canonFindings: oldCounts,
      uglyWithoutIsolation: oldUglyIds.length,
      uglyCampaignIds: oldUglyIds,
    },
    v2: {
      canonCompliant: canonCompliantFromFindings(opts.findings),
      canonFindings: v2Counts,
      uglyWithoutIsolation: v2UglyIds.length,
      uglyCampaignIds: v2UglyIds,
      intended,
    },
    diff: {
      findingsOnlyInOld,
      findingsOnlyInV2,
      uglyOnlyInOld: oldUglyIds.filter((id) => !v2UglyIds.includes(id)),
      uglyOnlyInV2: v2UglyIds.filter((id) => !oldUglyIds.includes(id)),
      intendedAttaches: intended.attach ?? 0,
      intendedDetaches: intended.detach ?? 0,
      intendedIsolations: intended.isolate ?? 0,
      intendedTests: (intended.test_create ?? 0) + (intended.test_stop ?? 0),
      intendedWordHunts: intended.word_hunt ?? 0,
      intendedReconnects: intended.reconnect ?? 0,
    },
    espInboxRates: opts.espInboxRates ?? [],
    qa: {
      scheduled: (opts.qaRuns ?? []).filter((r) => r.status === "scheduled" || r.status === "missed" || r.status === "completed" || r.status === "running").length,
      completed: (opts.qaRuns ?? []).filter((r) => r.status === "completed").length,
      missed: (opts.qaRuns ?? []).filter((r) => r.status === "missed").length,
    },
    notes,
  };
}

export function buildMetrics(opts: {
  espInboxRates: EspInboxDay[];
  qaRuns: QaRun[];
  limiter?: { inflight: number; waiting: number; rateLimitStreak: number; pausedForMs: number; requestsInWindow: number; maxPerMin: number };
}): {
  espInboxRates: EspInboxDay[];
  qa: { scheduled: number; completed: number; missed: number; running: number };
  limiter?: typeof opts.limiter;
} {
  const runs = opts.qaRuns;
  return {
    espInboxRates: opts.espInboxRates,
    qa: {
      scheduled: runs.filter((r) => r.status === "scheduled").length + runs.filter((r) => r.status === "completed" || r.status === "missed" || r.status === "running").length,
      completed: runs.filter((r) => r.status === "completed").length,
      missed: runs.filter((r) => r.status === "missed").length,
      running: runs.filter((r) => r.status === "running").length,
    },
    limiter: opts.limiter,
  };
}
