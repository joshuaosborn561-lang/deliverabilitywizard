/**
 * D286 — one-time (idempotent) generics-ledger cleanup.
 * Runs on the first seeder pass after deploy, not at boot (D122).
 *
 * 1. Release Insight-tagged generics to the free pool.
 * 2. Remove CornerStone-domain inboxes from the pool/ledger permanently.
 * 3. Strip stale POD tags from unassigned generics.
 * 4. Drop leftover "PowerGRYD no generics" findings.
 *
 * Never touches STOPPED campaigns. Never START/PAUSE. Canaries locked.
 * Deep Roots / Peterson are not restaffed.
 */

import {
  accountEmail,
  campaignIdsOf,
  type SmartleadAccountWithCampaigns,
} from "../clients/smartlead.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import type { SmartleadCampaign } from "../types/index.js";
import { isGenericMailbox } from "./clientInbox.js";
import { isLockedCanarySeat } from "./canaryLock.js";
import { INSIGHT_CLIENT_ID } from "./insightCampaigns.js";
import {
  isCornerstoneGenericDomain,
  ledgerNoRestaffClientId,
  type GenericLedgerCleanupStamp,
} from "./genericLedger.js";
import {
  emptyGenericSeat,
  genericSeatKey,
  podFromMailboxTags,
  type GenericSeatRecord,
} from "./genericPool.js";
import { returnGenericToUntaggedPool } from "./genericReturn.js";
import { GENERIC_POD_TAG_A, GENERIC_POD_TAG_B } from "./genericAssign.js";
import type { AppConfig } from "../config.js";
import type { StateStore } from "../state/store.js";
import { dropMembership } from "../services/inventory.js";
import { sleep } from "./http.js";

const WRITE_GAP_MS = process.env.NODE_TEST_CONTEXT ? 0 : 200;

export const GENERIC_LEDGER_CLEANUP_REASON = "d286_generics_ledger";
export const CORNERSTONE_EXCLUDED_REASON = "cornerstone_never_generic";
export type { GenericLedgerCleanupStamp };

export function isPowerGrydNoGenericsFinding(line: string): boolean {
  const text = line.toLowerCase();
  return text.includes("powergryd") && text.includes("no generics");
}

function campaignStatus(
  campaign: { status?: string | null } | undefined,
): string {
  return String(campaign?.status ?? "").toUpperCase();
}

function isStopped(status: string): boolean {
  return status === "STOPPED";
}

export function isInsightTaggedGeneric(input: {
  account?: Pick<SmartleadAccountWithCampaigns, "client_id">;
  seat?: Pick<GenericSeatRecord, "assignedClientId"> | null;
}): boolean {
  return (
    input.account?.client_id === INSIGHT_CLIENT_ID ||
    input.seat?.assignedClientId === INSIGHT_CLIENT_ID
  );
}

export async function runGenericLedgerCleanup(input: {
  config: Pick<
    AppConfig,
    "extraGenericMailboxes" | "extraGenericDomains" | "prewarmedDomains" | "dryRun"
  >;
  smartlead: Pick<
    SmartleadClient,
    "updateEmailAccount" | "removeEmailAccountsFromCampaign"
  > &
    Partial<Pick<SmartleadClient, "ensureTag" | "removeTags" | "configureWarmup">>;
  state: StateStore;
  accounts: SmartleadAccountWithCampaigns[];
  campaigns: Array<Pick<SmartleadCampaign, "id" | "status" | "client_id">>;
  dryRun?: boolean;
  now?: Date;
}): Promise<GenericLedgerCleanupStamp & { skipped: boolean; errors: string[] }> {
  const existing = input.state.getGenericLedgerCleanup?.() ??
    (input.state as { genericLedgerCleanup?: GenericLedgerCleanupStamp }).genericLedgerCleanup;
  if (existing?.ranAt) {
    return { ...existing, skipped: true, errors: [] };
  }
  const now = input.now ?? new Date();
  const dryRun = input.dryRun ?? input.config.dryRun;
  const campaignById = new Map(input.campaigns.map((row) => [row.id, row]));
  const errors: string[] = [];
  let insightReleased = 0;
  let cornerstoneExcluded = 0;
  let tagsStripped = 0;

  for (const account of input.accounts) {
    const email = accountEmail(account);
    if (!email || typeof account.id !== "number") continue;
    if (isLockedCanarySeat(account, email, input.state)) continue;
    const generic = isGenericMailbox(account, email, input.config, input.state);
    const seat = input.state.getGenericSeat(email);
    const cornerstone = isCornerstoneGenericDomain(email);

    if (cornerstone || seat?.excluded) {
      try {
        if (!dryRun) {
          for (const campaignId of campaignIdsOf(account)) {
            const campaign = campaignById.get(campaignId);
            if (isStopped(campaignStatus(campaign))) continue;
            if (ledgerNoRestaffClientId(campaign?.client_id ?? null)) continue;
            await input.smartlead.removeEmailAccountsFromCampaign(campaignId, [
              account.id,
            ]);
            dropMembership(account, campaignId);
            await sleep(WRITE_GAP_MS);
          }
          await input.smartlead.updateEmailAccount(account.id, {
            client_id: null,
            signature: "",
          });
          if (input.smartlead.ensureTag && input.smartlead.removeTags) {
            const tagA = await input.smartlead.ensureTag(GENERIC_POD_TAG_A, "#4FC3F7");
            const tagB = await input.smartlead.ensureTag(GENERIC_POD_TAG_B, "#9575CD");
            await input.smartlead.removeTags([account.id], [tagA.id, tagB.id]);
          }
          if (input.state.getPoolMailbox(email)) {
            input.state.removePoolMailbox(email);
          }
          input.state.upsertGenericSeat(
            emptyGenericSeat(email, {
              slAccountId: account.id,
              excluded: true,
              reason: CORNERSTONE_EXCLUDED_REASON,
              warmupEnabled: seat?.warmupEnabled ?? null,
            }),
          );
        }
        cornerstoneExcluded += 1;
      } catch (error) {
        errors.push(
          `${email}: cornerstone ${error instanceof Error ? error.message : error}`,
        );
      }
      continue;
    }

    if (generic && isInsightTaggedGeneric({ account, seat })) {
      const onActive = campaignIdsOf(account).some((id) => {
        const status = campaignStatus(campaignById.get(id));
        return status === "ACTIVE" || status === "START";
      });
      try {
        if (!dryRun) {
          if (!onActive) {
            for (const campaignId of campaignIdsOf(account)) {
              const campaign = campaignById.get(campaignId);
              if (isStopped(campaignStatus(campaign))) continue;
              await input.smartlead.removeEmailAccountsFromCampaign(campaignId, [
                account.id,
              ]);
              dropMembership(account, campaignId);
              await sleep(WRITE_GAP_MS);
            }
          }
          const cleared = await returnGenericToUntaggedPool({
            smartlead: input.smartlead,
            state: input.state,
            account,
            email,
            reason: GENERIC_LEDGER_CLEANUP_REASON,
            now,
          });
          if (!cleared.ok) {
            await input.smartlead.updateEmailAccount(account.id, {
              client_id: null,
              signature: "",
            });
            input.state.releaseGenericFromTable(email, {
              reason: GENERIC_LEDGER_CLEANUP_REASON,
              now,
            });
          }
        }
        insightReleased += 1;
      } catch (error) {
        errors.push(
          `${email}: insight ${error instanceof Error ? error.message : error}`,
        );
      }
      continue;
    }

    if (
      generic &&
      (account.client_id == null || account.client_id === undefined) &&
      (seat?.assignedClientId == null) &&
      podFromMailboxTags(account.tags) != null
    ) {
      try {
        if (!dryRun) {
          const cleared = await returnGenericToUntaggedPool({
            smartlead: input.smartlead,
            state: input.state,
            account,
            email,
            reason: "stale_pod_tag",
            now,
          });
          if (!cleared.ok && input.smartlead.ensureTag && input.smartlead.removeTags) {
            const tagA = await input.smartlead.ensureTag(GENERIC_POD_TAG_A, "#4FC3F7");
            const tagB = await input.smartlead.ensureTag(GENERIC_POD_TAG_B, "#9575CD");
            await input.smartlead.removeTags([account.id], [tagA.id, tagB.id]);
          }
        }
        tagsStripped += 1;
      } catch (error) {
        errors.push(
          `${email}: tags ${error instanceof Error ? error.message : error}`,
        );
      }
    }
  }

  const findings = input.state.listGenericPoolFindings();
  const kept = findings.filter((line) => !isPowerGrydNoGenericsFinding(line));
  const powergrydFindingsCleared = findings.length - kept.length;
  if (!dryRun && powergrydFindingsCleared > 0) {
    input.state.setGenericPoolFindings(kept);
  }
  for (const key of Object.keys(input.state.listCanonMissAlerts?.() ?? {})) {
    if (isPowerGrydNoGenericsFinding(key)) {
      if (!dryRun) input.state.clearCanonMissStamp(key);
    }
  }

  const stamp: GenericLedgerCleanupStamp = {
    ranAt: now.toISOString(),
    insightReleased,
    cornerstoneExcluded,
    tagsStripped,
    powergrydFindingsCleared,
  };
  if (!dryRun) {
    input.state.setGenericLedgerCleanup(stamp);
  }
  console.log(
    `[generic-ledger] cleanup insight=${insightReleased} cornerstone=${cornerstoneExcluded} tags=${tagsStripped} pgFindings=${powergrydFindingsCleared} errors=${errors.length}`,
  );
  return { ...stamp, skipped: false, errors };
}

export function planGenericLedgerCleanupCounts(input: {
  accounts: SmartleadAccountWithCampaigns[];
  state: Pick<StateStore, "getGenericSeat" | "getPoolMailbox" | "isCopyCanary" | "isMarkerClientId" | "listGenericPoolFindings">;
  config: Pick<AppConfig, "extraGenericMailboxes" | "extraGenericDomains" | "prewarmedDomains">;
}): {
  insightTagged: number;
  cornerstoneDomain: number;
  unassignedWithPodTags: number;
  powergrydNoGenericsFindings: number;
} {
  let insightTagged = 0;
  let cornerstoneDomain = 0;
  let unassignedWithPodTags = 0;
  for (const account of input.accounts) {
    const email = accountEmail(account);
    if (!email) continue;
    if (isLockedCanarySeat(account, email, input.state)) continue;
    const generic = isGenericMailbox(account, email, input.config, input.state);
    const seat = input.state.getGenericSeat(email);
    if (isCornerstoneGenericDomain(email)) {
      cornerstoneDomain += 1;
      continue;
    }
    if (generic && isInsightTaggedGeneric({ account, seat })) {
      insightTagged += 1;
      continue;
    }
    if (
      generic &&
      account.client_id == null &&
      seat?.assignedClientId == null &&
      podFromMailboxTags(account.tags) != null
    ) {
      unassignedWithPodTags += 1;
    }
  }
  return {
    insightTagged,
    cornerstoneDomain,
    unassignedWithPodTags,
    powergrydNoGenericsFindings: input.state
      .listGenericPoolFindings()
      .filter(isPowerGrydNoGenericsFinding).length,
  };
}
