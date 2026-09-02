/**
 * D158 — same-ESP inbox under the live 80% bar on a canary-copy or live
 * campaign placement is a copy-suspect flag. Isolation then reads canary
 * + known-good (D93/D96). D163 pages Slack once per campaign per
 * incident. D164 re-queues when the latest run is INCONCLUSIVE.
 */

import { isAnyShellCampaign } from "./canaryShell.js";
import { anyEspBelowThreshold, type ProviderInboxSplit } from "./copySignal.js";
import {
  campaignIdFromCanaryTestName,
  isCanaryCopyTestName,
  isIsolationManagedTestName,
} from "./isolationNames.js";

export interface PlacementSuspectCampaign {
  id: number;
  name?: string | null;
  status?: string | null;
}

export type PlacementSuspectSource = "canary-copy" | "live-placement";

export interface PlacementSuspectTarget {
  campaignId: number;
  campaignName?: string;
  source: PlacementSuspectSource;
}

export function isActiveSendingStatus(
  status: string | undefined | null,
): boolean {
  return String(status ?? "").toUpperCase() === "ACTIVE";
}

/**
 * Map a SmartDelivery test to the ACTIVE live campaign it diagnoses.
 * Canary-copy tests hang on a paused shell (`campaign_id` is the shell) —
 * the live id lives in the test name. Shells, pod-control, isolation, and
 * rig tests are never the target (D126 board hide stays; canary ugliness
 * still counts for the live campaign).
 */
export function liveCampaignForPlacementTrigger(opts: {
  testName?: string;
  testCampaignId?: string | number | null;
  campaigns: PlacementSuspectCampaign[];
}): PlacementSuspectTarget | undefined {
  const fromCanary = campaignIdFromCanaryTestName(opts.testName);
  if (fromCanary != null) {
    return activeLiveTarget(fromCanary, opts.campaigns, "canary-copy");
  }
  if (isCanaryCopyTestName(opts.testName)) return undefined;
  if (isIsolationManagedTestName(opts.testName)) return undefined;

  const raw = opts.testCampaignId;
  if (raw === undefined || raw === null || raw === "") return undefined;
  const id = Number(raw);
  if (!Number.isFinite(id)) return undefined;
  return activeLiveTarget(id, opts.campaigns, "live-placement");
}

function activeLiveTarget(
  campaignId: number,
  campaigns: PlacementSuspectCampaign[],
  source: PlacementSuspectSource,
): PlacementSuspectTarget | undefined {
  const campaign = campaigns.find((row) => row.id === campaignId);
  if (!campaign) return undefined;
  if (isAnyShellCampaign(campaign)) return undefined;
  if (!isActiveSendingStatus(campaign.status)) return undefined;
  return {
    campaignId: campaign.id,
    campaignName: campaign.name ?? undefined,
    source,
  };
}

export function sameEspInboxUgly(
  providers: ProviderInboxSplit[],
  threshold: number,
): boolean {
  if (!providers.length) return false;
  return anyEspBelowThreshold(providers, threshold);
}

/** Weakest same-ESP inbox % on the test, or null when nothing scored. */
export function minSameEspInbox(
  providers: ProviderInboxSplit[],
): number | null {
  if (!providers.length) return null;
  return Math.min(...providers.map((row) => row.inboxPercent));
}

export function hasOpenIsolation(opts: {
  existing?: { evaluatedAt?: string };
  openRun?: { teardownStarted?: boolean; verdict?: string };
}): boolean {
  if (opts.existing && !opts.existing.evaluatedAt) return true;
  if (opts.openRun?.teardownStarted) return true;
  if (opts.openRun?.verdict === "COPY" || opts.openRun?.verdict === "INFRA") {
    return true;
  }
  return false;
}

export interface UglyWithoutIsolationRow {
  campaignId: number;
  campaignName?: string;
  source: PlacementSuspectSource;
  testId: string;
  inboxPercent: number;
}

/** QA: scored under the live bar with no suspect and no COPY/INFRA run. */
export function uglyWithoutIsolation(opts: {
  scores: Array<{
    campaignId: number;
    campaignName?: string;
    source: PlacementSuspectSource;
    testId: string;
    inboxPercent: number;
  }>;
  suspects: Array<{ campaignId: number; evaluatedAt?: string }>;
  latestRun: (campaignId: number) =>
    | { teardownStarted?: boolean; verdict?: string }
    | undefined;
  threshold: number;
}): UglyWithoutIsolationRow[] {
  const suspectById = new Map(opts.suspects.map((row) => [row.campaignId, row]));
  const out: UglyWithoutIsolationRow[] = [];
  for (const score of opts.scores) {
    if (score.inboxPercent >= opts.threshold) continue;
    if (
      hasOpenIsolation({
        existing: suspectById.get(score.campaignId),
        openRun: opts.latestRun(score.campaignId),
      })
    ) {
      continue;
    }
    out.push({
      campaignId: score.campaignId,
      campaignName: score.campaignName,
      source: score.source,
      testId: score.testId,
      inboxPercent: score.inboxPercent,
    });
  }
  return out.sort((a, b) => a.campaignId - b.campaignId);
}

export function placementIsolationHealth(opts: {
  scores: Array<{
    campaignId: number;
    campaignName?: string;
    source: PlacementSuspectSource;
    testId: string;
    inboxPercent: number;
  }>;
  suspects: Array<{ campaignId: number; evaluatedAt?: string }>;
  latestRun: (campaignId: number) =>
    | { teardownStarted?: boolean; verdict?: string }
    | undefined;
  threshold: number;
  lastOkAt: string | null;
}): {
  lastOkAt: string | null;
  threshold: number;
  scored: number;
  ugly: number;
  uglyWithoutIsolation: UglyWithoutIsolationRow[];
} {
  const holes = uglyWithoutIsolation(opts);
  return {
    lastOkAt: opts.lastOkAt,
    threshold: opts.threshold,
    scored: opts.scores.length,
    ugly: opts.scores.filter((row) => row.inboxPercent < opts.threshold).length,
    uglyWithoutIsolation: holes,
  };
}

/**
 * Inverse of hasOpenIsolation (D164). An unevaluated suspect, an open
 * word hunt, or a latest COPY/INFRA run already owns the campaign — do
 * not re-queue. evaluatedAt alone is not a lock: a later INCONCLUSIVE
 * (or a stamp with no covering COPY/INFRA/HEALTHY run) must re-queue
 * so tonight's still-ugly canary is not stuck forever.
 */
export function shouldQueuePlacementSuspect(opts: {
  existing?: { evaluatedAt?: string };
  openRun?: { teardownStarted?: boolean; verdict?: string };
}): boolean {
  return !hasOpenIsolation(opts);
}

export function placementSuspectReason(
  source: PlacementSuspectSource,
  providers: ProviderInboxSplit[],
  threshold: number,
): string {
  const weak = providers
    .filter((row) => row.inboxPercent < threshold)
    .map((row) => `${row.name} ${row.inboxPercent.toFixed(0)}%`)
    .join(", ");
  const where =
    source === "canary-copy"
      ? "Canary-copy same-ESP"
      : "Live placement same-ESP";
  return weak
    ? `${where} under ${threshold}% (${weak}).`
    : `${where} under ${threshold}%.`;
}

export function isTerminalIsolationVerdict(
  verdict: string | undefined,
): boolean {
  return verdict === "COPY" || verdict === "INFRA" || verdict === "HEALTHY";
}
