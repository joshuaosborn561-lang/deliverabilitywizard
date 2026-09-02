/**
 * D158 — same-ESP inbox under the live 80% bar on a canary-copy or live
 * campaign placement is a copy-suspect flag, not a Slack page (D71).
 * Isolation then reads canary + known-good (D93/D96).
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

/**
 * Do not re-hunt every monitor tick. An unevaluated suspect is already
 * queued; a terminal isolation run or an open word hunt owns the campaign.
 */
export function shouldQueuePlacementSuspect(opts: {
  existing?: { evaluatedAt?: string };
  openRun?: { teardownStarted?: boolean; verdict?: string };
}): boolean {
  if (opts.existing && !opts.existing.evaluatedAt) return false;
  if (opts.existing?.evaluatedAt) return false;
  if (opts.openRun?.teardownStarted) return false;
  if (opts.openRun?.verdict === "COPY" || opts.openRun?.verdict === "INFRA") {
    return false;
  }
  return true;
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
