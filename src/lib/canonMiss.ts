/**
 * D162 — a CANON / healthy-sending miss pages Slack once per campaign
 * per incident. Same-ESP under 80%, a newly queued suspect, and an
 * isolation verdict of COPY / INFRA / INCONCLUSIVE are incidents.
 * A 15-minute re-read of the same incident is not.
 */

import type { PlacementSuspectSource } from "./placementSuspect.js";

export type CanonMissKind =
  | "ugly"
  | "queued"
  | "COPY"
  | "INFRA"
  | "INCONCLUSIVE";

export interface CanonMissRow {
  campaignId: number;
  campaignName?: string;
  kind: CanonMissKind;
  detail: string;
  inboxPercent?: number;
  source?: PlacementSuspectSource;
}

export function isCanonMissVerdict(
  verdict: string | undefined,
): verdict is "COPY" | "INFRA" | "INCONCLUSIVE" {
  return verdict === "COPY" || verdict === "INFRA" || verdict === "INCONCLUSIVE";
}

export function currentCanonMiss(opts: {
  campaignId: number;
  campaignName?: string;
  score?: {
    inboxPercent: number;
    source: PlacementSuspectSource;
    reason?: string;
  };
  suspect?: { evaluatedAt?: string; reason?: string; campaignName?: string };
  latestRun?: { teardownStarted?: boolean; verdict?: string; reason?: string };
  threshold: number;
}): CanonMissRow | null {
  const name = opts.campaignName ?? opts.suspect?.campaignName;
  const ugly =
    opts.score != null && opts.score.inboxPercent < opts.threshold;
  if (opts.score != null && !ugly) return null;

  const detail = missDetail(opts);
  if (isCanonMissVerdict(opts.latestRun?.verdict)) {
    return {
      campaignId: opts.campaignId,
      campaignName: name,
      kind: opts.latestRun.verdict,
      detail,
      inboxPercent: opts.score?.inboxPercent,
      source: opts.score?.source,
    };
  }
  if (opts.suspect && !opts.suspect.evaluatedAt) {
    return {
      campaignId: opts.campaignId,
      campaignName: name,
      kind: "queued",
      detail,
      inboxPercent: opts.score?.inboxPercent,
      source: opts.score?.source,
    };
  }
  if (ugly) {
    return {
      campaignId: opts.campaignId,
      campaignName: name,
      kind: "ugly",
      detail,
      inboxPercent: opts.score?.inboxPercent,
      source: opts.score?.source,
    };
  }
  return null;
}

function missDetail(opts: {
  score?: { inboxPercent: number; source: PlacementSuspectSource };
  suspect?: { reason?: string };
  latestRun?: { verdict?: string; reason?: string };
  threshold: number;
}): string {
  if (opts.score) {
    const where =
      opts.score.source === "canary-copy" ? "canary-copy" : "live placement";
    return `${where} same-ESP ${opts.score.inboxPercent.toFixed(0)}% (bar ${opts.threshold}%)`;
  }
  if (opts.suspect?.reason) return opts.suspect.reason;
  if (opts.latestRun?.reason) return opts.latestRun.reason;
  return "healthy-sending miss";
}

export function collectCanonMisses(opts: {
  scores: Array<{
    campaignId: number;
    campaignName?: string;
    inboxPercent: number;
    source: PlacementSuspectSource;
  }>;
  suspects: Array<{
    campaignId: number;
    campaignName?: string;
    evaluatedAt?: string;
    reason?: string;
  }>;
  latestRun: (campaignId: number) =>
    | { teardownStarted?: boolean; verdict?: string; reason?: string }
    | undefined;
  threshold: number;
  extraCampaignIds?: number[];
}): CanonMissRow[] {
  const scoreById = new Map(opts.scores.map((row) => [row.campaignId, row]));
  const suspectById = new Map(opts.suspects.map((row) => [row.campaignId, row]));
  const ids = new Set<number>([
    ...scoreById.keys(),
    ...suspectById.keys(),
    ...(opts.extraCampaignIds ?? []),
  ]);
  const out: CanonMissRow[] = [];
  for (const campaignId of ids) {
    const score = scoreById.get(campaignId);
    const suspect = suspectById.get(campaignId);
    const miss = currentCanonMiss({
      campaignId,
      campaignName: score?.campaignName ?? suspect?.campaignName,
      score,
      suspect,
      latestRun: opts.latestRun(campaignId),
      threshold: opts.threshold,
    });
    if (miss) out.push(miss);
  }
  return out.sort((a, b) => a.campaignId - b.campaignId);
}

export function canonMissText(row: CanonMissRow): string {
  const who = row.campaignName
    ? `${row.campaignName} #${row.campaignId}`
    : `campaign #${row.campaignId}`;
  const headline = missHeadline(row.kind);
  return [
    `:rotating_light: CANON miss — ${headline}`,
    `• \`${who}\` — ${row.detail}`,
    missNext(row.kind),
    "Investigate in-thread. Isolation remediates; this page is the alert, not a retire ask.",
  ].join("\n");
}

function missHeadline(kind: CanonMissKind): string {
  if (kind === "ugly") return "same-ESP inbox under 80%";
  if (kind === "queued") return "isolation queued";
  if (kind === "COPY") return "isolation evaluated COPY";
  if (kind === "INFRA") return "isolation evaluated INFRA";
  return "isolation evaluated INCONCLUSIVE";
}

function missNext(kind: CanonMissKind): string {
  if (kind === "COPY") {
    return "Copy path: word hunt runs; Slack will fire again when it has the phrase + substitute.";
  }
  if (kind === "INFRA") {
    return "Infra path: sender/domain, not the copy. A burned-domain retire ask is a separate page.";
  }
  if (kind === "INCONCLUSIVE") {
    return "No COPY/INFRA cover yet — the next 15-minute sweep re-queues and re-reads.";
  }
  if (kind === "queued") {
    return "On-ramp marked a copy suspect; evaluate runs on this sweep.";
  }
  return "No open isolation run is covering this ugly reading — the on-ramp should queue it.";
}
