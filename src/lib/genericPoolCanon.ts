import { accountEmail, campaignIdsOf } from "../clients/smartlead.js";
import { applyLedgerPins } from "./ledgerPins.js";
import type { SmartleadAccountWithCampaigns } from "../clients/smartlead.js";
import type { AppConfig } from "../config.js";
import type { StateStore } from "../state/store.js";
import type { SmartleadEmailAccount } from "../types/index.js";
import {
  isGabeVmReserved,
  isLockedCanarySeat,
} from "./canaryLock.js";
import { isClientInbox, isGenericMailbox } from "./clientInbox.js";
import { owesWarmup, warmupClockStartedAt } from "../services/warmupGate.js";
import { isRealNamedClientId } from "./dedicatedGeneric.js";
import { realignStalePoolAssignment } from "./genericPoolRealign.js";
import { assignClientCohorts } from "./restCohort.js";
import { isStaffableSender } from "./staffableSender.js";
import { rankGenericsOldestWorstFirst } from "./genericAssign.js";
import { displayStaffedSenders } from "./displaySenderCount.js";
import { mailboxStaffableWeight, roundStaffableWeight } from "./mailboxType.js";
import { isGabeFollowUpCampaign } from "./pocClient.js";
import { pickWeightedGenericReturns } from "./namedWarmSwap.js";
import { createLoopYielder } from "./stringifyYielding.js";
import { mailboxWarmupIsOn } from "./mailboxSendSettings.js";
import {
  alreadyCoveredEmails,
  freeWarmGenericCount,
  isCornerstoneGenericDomain,
  isInsightClientId,
  linkCoveringFor,
  podShortNoFreeGeneric,
  warmReadyAtFromClock,
  warmingSeatsByClientPod,
  type WarmingBrandedSeat,
} from "./genericLedger.js";
import { INSIGHT_CLIENT_ID } from "./insightCampaigns.js";
import {
  GENERIC_ASSIGN_REASON_POD_TOP_UP,
  GENERIC_ASSIGN_REASON_POC_ENGAGEMENT,
  GENERIC_ASSIGN_REASON_POWERGRYD,
  GENERIC_POOL_POWERGRYD_CLIENT_ID,
  clearGenericAssignment,
  clientPodKey,
  emptyGenericSeat,
  genericPoolIdleExempt,
  genericPoolNeedForPod,
  genericProviderFromAccountType,
  genericSeatKey,
  seatStaffableWeight,
  mergeSeededGenericSeat,
  normalizeGenericSeat,
  podFromMailboxTags,
  type GenericAssignedPod,
  type GenericPoolCoreKind,
  type GenericSeatRecord,
} from "./genericPool.js";

export type { GenericPoolCoreKind, GenericSeatRecord };

export interface GenericPoolFinding {
  kind: GenericPoolCoreKind;
  email: string;
  detail: string;
}

export function genericPoolFindingLine(finding: GenericPoolFinding): string {
  return `${finding.kind}: ${finding.detail}`;
}

export function parseGenericPoolFinding(
  line: string,
): { kind: string; detail: string } {
  const idx = line.indexOf(":");
  if (idx < 0) return { kind: line.trim() || "unknown", detail: "" };
  return {
    kind: line.slice(0, idx).trim() || "unknown",
    detail: line.slice(idx + 1).trim(),
  };
}

function uniquePositiveIds(ids: Iterable<number | null | undefined>): number[] {
  return [
    ...new Set(
      [...ids].filter((id): id is number => typeof id === "number" && id > 0),
    ),
  ].sort((a, b) => a - b);
}

function campaignIsActive(status: string | null | undefined): boolean {
  const value = String(status ?? "").toUpperCase();
  return value === "ACTIVE" || value === "START";
}

function campaignIsLivingForClient(
  status: string | null | undefined,
  clientId: number | null,
  pocEngagementClientIds: ReadonlySet<number>,
): boolean {
  if (campaignIsActive(status)) return true;
  if (clientId == null || !pocEngagementClientIds.has(clientId)) return false;
  const value = String(status ?? "").toUpperCase();
  return value === "DRAFT" || value === "DRAFTED";
}

/**
 * D221 — fail when a generic is assigned to a client that does not
 * need it for that POD's 40, or when one seat is on more than one
 * client. PowerGRYD dedicated seats and the 24h TERRL substitute
 * skip the idle check (still same-client; multi-client still fails).
 */
export function validateGenericPool(input: {
  seats: GenericSeatRecord[];
  namedStaffableByClientPod: ReadonlyMap<string, number>;
  clientHasActiveCampaign?: ReadonlyMap<number, boolean>;
  campaignClientById?: ReadonlyMap<number, number | null>;
  liveClientIdsByEmail?: ReadonlyMap<string, readonly number[]>;
  powerGrydClientId?: number;
  pocEngagementClientIds?: Iterable<number>;
  idleExemptEmails?: Iterable<string>;
  minFloorByClient?: Readonly<Record<number, number>>;
  now?: Date;
  insightClientId?: number;
}): GenericPoolFinding[] {
  const powerId = input.powerGrydClientId ?? GENERIC_POOL_POWERGRYD_CLIENT_ID;
  const pocIds = new Set(
    [...(input.pocEngagementClientIds ?? [])].filter(
      (id) => Number.isFinite(id) && id > 0,
    ),
  );
  const idleExempt = new Set(
    [...(input.idleExemptEmails ?? [])].map((email) => email.trim().toLowerCase()),
  );
  const findings: GenericPoolFinding[] = [];
  const seen = new Set<string>();
  const push = (finding: GenericPoolFinding): void => {
    const line = genericPoolFindingLine(finding);
    if (seen.has(line)) return;
    seen.add(line);
    findings.push(finding);
  };

  const byEmail = new Map<string, GenericSeatRecord[]>();
  for (const raw of input.seats) {
    const seat = normalizeGenericSeat(raw);
    if (!seat) continue;
    const list = byEmail.get(seat.email) ?? [];
    list.push(seat);
    byEmail.set(seat.email, list);
  }

  for (const [email, rows] of byEmail) {
    const tableClients = uniquePositiveIds(rows.map((row) => row.assignedClientId));
    const live = uniquePositiveIds(input.liveClientIdsByEmail?.get(email) ?? []);
    const campaignClients = uniquePositiveIds(
      rows.flatMap((row) =>
        row.assignedCampaignIds.map(
          (id) => input.campaignClientById?.get(id) ?? null,
        ),
      ),
    );
    const clients = uniquePositiveIds([...tableClients, ...live, ...campaignClients]);
    if (clients.length > 1) {
      push({
        kind: "generic_multi_client",
        email,
        detail: `${email} assigned to clients ${clients.join(",")}`,
      });
    }
    const liveAssigned = live.length > 0 || campaignClients.length > 0;
    if (liveAssigned && tableClients.length === 0) {
      push({
        kind: "generic_outside_table",
        email,
        detail: `${email} assigned outside the generics table`,
      });
      push({
        kind: "generic_outside_ledger",
        email,
        detail: `${email} on a live campaign without a ledger row`,
      });
    }
    const insightId = input.insightClientId ?? INSIGHT_CLIENT_ID;
    if (clients.includes(insightId) || tableClients.includes(insightId)) {
      push({
        kind: "generic_on_insight",
        email,
        detail: `${email} tagged to Insight ${insightId}`,
      });
    }
  }

  for (const [email, live] of input.liveClientIdsByEmail ?? []) {
    const key = genericSeatKey(email);
    if (uniquePositiveIds(live).length === 0) continue;
    if (byEmail.has(key)) continue;
    push({
      kind: "generic_outside_table",
      email: key,
      detail: `${key} assigned outside the generics table`,
    });
    push({
      kind: "generic_outside_ledger",
      email: key,
      detail: `${key} on a live campaign without a ledger row`,
    });
  }

  const assignedByClientPod = new Map<string, GenericSeatRecord[]>();
  const assignedUnpodded = new Map<number, GenericSeatRecord[]>();

  for (const rows of byEmail.values()) {
    const seat = rows[0]!;
    const clientId = seat.assignedClientId;
    if (clientId == null) continue;
    if (
      genericPoolIdleExempt(seat, {
        powerGrydClientId: powerId,
        pocEngagementClientIds: pocIds,
      })
    ) {
      continue;
    }
    if (idleExempt.has(seat.email)) continue;
    if (seat.assignedPod) {
      const key = clientPodKey(clientId, seat.assignedPod);
      const list = assignedByClientPod.get(key) ?? [];
      list.push(seat);
      assignedByClientPod.set(key, list);
    } else {
      const list = assignedUnpodded.get(clientId) ?? [];
      list.push(seat);
      assignedUnpodded.set(clientId, list);
    }
  }

  const idleEmails = new Set<string>();
  const markSurplus = (
    seats: GenericSeatRecord[],
    namedStaffable: number,
    why: string,
    returnAll = false,
  ): void => {
    const ranked = returnAll
      ? rankGenericsOldestWorstFirst(seats)
      : pickWeightedGenericReturns(seats, { namedStaffable });
    for (const seat of ranked) {
      if (idleEmails.has(seat.email)) continue;
      idleEmails.add(seat.email);
      push({
        kind: "generic_idle",
        email: seat.email,
        detail: `${seat.email} ${why}`,
      });
    }
  };

  const clientIds = new Set<number>([
    ...[...assignedByClientPod.keys()].map((key) => Number(key.split(":")[0])),
    ...assignedUnpodded.keys(),
  ]);

  for (const clientId of clientIds) {
    const hasActive = input.clientHasActiveCampaign?.get(clientId);
    const pods: GenericAssignedPod[] = ["A", "B"];
    let totalNeed = 0;
    const perPodNeed = new Map<GenericAssignedPod, number>();
    for (const pod of pods) {
      const named = input.namedStaffableByClientPod.get(clientPodKey(clientId, pod)) ?? 0;
      const need = hasActive === false ? 0 : genericPoolNeedForPod(named);
      perPodNeed.set(pod, need);
      totalNeed += need;
    }

    for (const pod of pods) {
      const seats = assignedByClientPod.get(clientPodKey(clientId, pod)) ?? [];
      const named = input.namedStaffableByClientPod.get(clientPodKey(clientId, pod)) ?? 0;
      const assignedWeight = seats.reduce(
        (sum, seat) => sum + seatStaffableWeight(seat),
        0,
      );
      const why =
        hasActive === false
          ? `assigned to client ${clientId} POD ${pod} but that client has no ACTIVE campaign`
          : `assigned to client ${clientId} POD ${pod} but is not needed to reach ${40} (named ${displayStaffedSenders(named)}, assigned ${displayStaffedSenders(assignedWeight)})`;
      markSurplus(seats, named, why, hasActive === false);
    }

    const unpodded = assignedUnpodded.get(clientId) ?? [];
    if (!unpodded.length) continue;
    const poddedAssigned = pods.reduce(
      (sum, pod) =>
        sum +
        (assignedByClientPod.get(clientPodKey(clientId, pod)) ?? []).reduce(
          (inner, seat) => inner + seatStaffableWeight(seat),
          0,
        ),
      0,
    );
    const leftoverNeed = Math.max(0, totalNeed - poddedAssigned);
    const why =
      hasActive === false
        ? `assigned to client ${clientId} but that client has no ACTIVE campaign`
        : `assigned to client ${clientId} but is not needed to bring either POD to 40`;
    markSurplus(
      unpodded,
      Math.max(0, 40 - leftoverNeed),
      why,
      hasActive === false,
    );
  }

  const now = input.now ?? new Date();
  const freeWarm = freeWarmGenericCount(input.seats, now);
  for (const rows of byEmail.values()) {
    const seat = rows[0]!;
    if (seat.excluded) continue;
    if (seat.warmupEnabled === false) {
      push({
        kind: "generic_not_warming",
        email: seat.email,
        detail: `${seat.email} warmup is off`,
      });
    }
    if (isInsightClientId(seat.assignedClientId)) {
      push({
        kind: "generic_on_insight",
        email: seat.email,
        detail: `${seat.email} tagged to Insight ${seat.assignedClientId}`,
      });
    }
  }

  const pods: GenericAssignedPod[] = ["A", "B"];
  const clientIdsForShort = new Set<number>([
    ...[...input.namedStaffableByClientPod.keys()]
      .map((key) => Number(key.split(":")[0]))
      .filter((id) => Number.isFinite(id) && id > 0),
    ...[...assignedByClientPod.keys()].map((key) => Number(key.split(":")[0])),
  ]);
  for (const clientId of clientIdsForShort) {
    if (input.clientHasActiveCampaign?.get(clientId) === false) continue;
    for (const pod of pods) {
      const key = clientPodKey(clientId, pod);
      if (
        !input.namedStaffableByClientPod.has(key) &&
        !assignedByClientPod.has(key)
      ) {
        continue;
      }
      const named =
        input.namedStaffableByClientPod.get(key) ?? 0;
      const assignedWeight = (
        assignedByClientPod.get(clientPodKey(clientId, pod)) ?? []
      ).reduce((sum, seat) => sum + seatStaffableWeight(seat), 0);
      if (
        podShortNoFreeGeneric({
          namedStaffable: named,
          assignedWeight,
          freeWarm,
          clientId,
          minFloorByClient: input.minFloorByClient,
        })
      ) {
        push({
          kind: "pod_short_no_free_generic",
          email: `client-${clientId}-pod-${pod}`,
          detail: `client ${clientId} POD ${pod} under floor with no free warm generic`,
        });
      }
    }
  }

  return findings.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    return a.email.localeCompare(b.email);
  });
}

export interface GenericPoolSyncAccount extends SmartleadEmailAccount {
  campaign_ids?: unknown;
}

export interface GenericPoolSyncInput {
  existing: GenericSeatRecord[];
  accounts: GenericPoolSyncAccount[];
  campaigns: Array<{
    id: number;
    client_id?: number | null;
    status?: string | null;
  }>;
  config: Pick<
    AppConfig,
    "extraGenericMailboxes" | "extraGenericDomains" | "prewarmedDomains"
  > &
    Partial<Pick<AppConfig, "campaignMinWarmupDays" | "freshInboxWarmupDays">>;
  state: Pick<StateStore, "getPoolMailbox" | "isCopyCanary"> & {
    isMarkerClientId?: StateStore["isMarkerClientId"];
    getCopyCanaryFleet?: StateStore["getCopyCanaryFleet"];
    upsertPoolMailbox?: StateStore["upsertPoolMailbox"];
  };
  now?: Date;
  powerGrydClientId?: number;
  pocEngagementClientIds?: Iterable<number>;
}

export interface GenericPoolSyncResult {
  seats: GenericSeatRecord[];
  namedStaffableByClientPod: Map<string, number>;
  clientHasActiveCampaign: Map<number, boolean>;
  campaignClientById: Map<number, number | null>;
  liveClientIdsByEmail: Map<string, number[]>;
  warmupOffEmails: string[];
  unassignedWithPodTags: string[];
  warmingBranded: WarmingBrandedSeat[];
}

function liveClientsForAccount(
  account: SmartleadAccountWithCampaigns,
  campaignClientById: ReadonlyMap<number, number | null>,
  isMarker?: (id: number | null | undefined) => boolean,
): number[] {
  return uniquePositiveIds(
    campaignIdsOf(account)
      .map((id) => campaignClientById.get(id) ?? null)
      .filter((id) => isRealNamedClientId(id, isMarker)),
  );
}

function assignedReason(
  existing: GenericSeatRecord | undefined,
  clientId: number | null,
  powerId: number,
  pocEngagementClientIds: ReadonlySet<number>,
): string | null {
  if (clientId == null) return null;
  if (existing?.reason && existing.assignedClientId === clientId) {
    return existing.reason;
  }
  if (pocEngagementClientIds.has(clientId)) {
    return GENERIC_ASSIGN_REASON_POC_ENGAGEMENT;
  }
  if (clientId === powerId) return GENERIC_ASSIGN_REASON_POWERGRYD;
  return GENERIC_ASSIGN_REASON_POD_TOP_UP;
}

/** D269 — yield inside the inventory seed so min40/health start cannot pin the loop. */
export const GENERIC_SYNC_YIELD_EVERY = 32;

/**
 * Rebuild the generics table from the shared Smartlead inventory.
 * Assignment is whoever currently has the seat (client_id / campaigns);
 * the validator then decides whether that assignment is still needed.
 * D269 — yields so a 1400-seat seed at min40 / health start cannot
 * pin the event loop for seconds.
 */
export async function syncGenericSeatsFromInventory(
  input: GenericPoolSyncInput,
): Promise<GenericPoolSyncResult> {
  const now = input.now ?? new Date();
  const powerId = input.powerGrydClientId ?? GENERIC_POOL_POWERGRYD_CLIENT_ID;
  const pocIds = new Set(
    [...(input.pocEngagementClientIds ?? [])].filter(
      (id) => Number.isFinite(id) && id > 0,
    ),
  );
  const isMarker = input.state.isMarkerClientId?.bind(input.state);
  const existingByEmail = new Map(
    input.existing
      .map((row) => normalizeGenericSeat(row))
      .filter((row): row is GenericSeatRecord => row != null)
      .map((row) => [row.email, row]),
  );
  const campaignClientById = new Map<number, number | null>();
  const clientHasActiveCampaign = new Map<number, boolean>();
  for (const campaign of input.campaigns) {
    if (!Number.isFinite(campaign.id)) continue;
    const clientId =
      typeof campaign.client_id === "number" && campaign.client_id > 0
        ? campaign.client_id
        : null;
    campaignClientById.set(campaign.id, clientId);
    if (isGabeFollowUpCampaign(campaign)) {
      if (clientId != null && !clientHasActiveCampaign.has(clientId)) {
        clientHasActiveCampaign.set(clientId, false);
      }
      continue;
    }
    if (clientId != null && campaignIsLivingForClient(campaign.status, clientId, pocIds)) {
      clientHasActiveCampaign.set(clientId, true);
    } else if (clientId != null && !clientHasActiveCampaign.has(clientId)) {
      clientHasActiveCampaign.set(clientId, false);
    }
  }

  const namedByClient = new Map<string, Array<{ email: string; type?: string | null }>>();
  const namedStaffableByClientPod = new Map<string, number>();
  const liveClientIdsByEmail = new Map<string, number[]>();
  const nextSeats: GenericSeatRecord[] = [];
  const accountByEmail = new Map<string, (typeof input.accounts)[number]>();
  const warmingBranded: WarmingBrandedSeat[] = [];
  const warmupOffEmails: string[] = [];
  const unassignedWithPodTags: string[] = [];

  const yieldSeed = createLoopYielder(GENERIC_SYNC_YIELD_EVERY);
  for (const account of input.accounts) {
    await yieldSeed();
    const email = accountEmail(account);
    if (!email) continue;
    accountByEmail.set(email, account);
    if (isLockedCanarySeat(account, email, input.state)) continue;
    const withCampaigns = account as SmartleadAccountWithCampaigns;
    const existingExcluded = existingByEmail.get(genericSeatKey(email));
    if (isCornerstoneGenericDomain(email) || existingExcluded?.excluded) {
      nextSeats.push(
        mergeSeededGenericSeat(
          existingExcluded,
          emptyGenericSeat(email, {
            slAccountId:
              typeof account.id === "number"
                ? account.id
                : existingExcluded?.slAccountId ?? null,
            provider: genericProviderFromAccountType(account.type),
            excluded: true,
            warmupEnabled: mailboxWarmupIsOn(account),
            reason: existingExcluded?.reason ?? "cornerstone_never_generic",
          }),
          now,
        ),
      );
      continue;
    }
    const generic = isGenericMailbox(account, email, input.config, input.state);
    if (!generic) {
      const clientId =
        typeof account.client_id === "number" &&
        isRealNamedClientId(account.client_id, isMarker)
          ? account.client_id
          : null;
      const tagged = podFromMailboxTags(account.tags);
      const warming = owesWarmup(
        account as SmartleadAccountWithCampaigns,
        email,
        {
          campaignMinWarmupDays: input.config.campaignMinWarmupDays ?? 21,
          freshInboxWarmupDays: input.config.freshInboxWarmupDays ?? 21,
          prewarmedDomains: input.config.prewarmedDomains,
          extraGenericMailboxes: input.config.extraGenericMailboxes,
        },
        input.state,
      );
      if (
        clientId != null &&
        tagged &&
        warming &&
        isClientInbox(account, email, input.config, input.state) &&
        !isGabeVmReserved(account)
      ) {
        warmingBranded.push({
          email,
          clientId,
          pod: tagged,
          warmReadyAt: warmReadyAtFromClock(
            warmupClockStartedAt(
              account as SmartleadAccountWithCampaigns,
              email,
              input.state,
            ),
            input.config.campaignMinWarmupDays ?? 21,
            now,
          ),
        });
      }
      if (
        !isClientInbox(account, email, input.config, input.state) ||
        isGabeVmReserved(account) ||
        !isStaffableSender(account, {
          copyCanary: Boolean(input.state.isCopyCanary?.(email)),
        }) ||
        warming
      ) {
        continue;
      }
      if (clientId == null) continue;
      const list = namedByClient.get(String(clientId)) ?? [];
      list.push({
        email,
        type: account.type,
      });
      namedByClient.set(String(clientId), list);
      if (tagged) {
        const key = clientPodKey(clientId, tagged);
        namedStaffableByClientPod.set(
          key,
          roundStaffableWeight(
            (namedStaffableByClientPod.get(key) ?? 0) +
              mailboxStaffableWeight(account),
          ),
        );
      }
      continue;
    }

    const liveClients = liveClientsForAccount(
      withCampaigns,
      campaignClientById,
      isMarker,
    );
    liveClientIdsByEmail.set(email, liveClients);

    const existing = existingByEmail.get(genericSeatKey(email));
    const mailboxClient =
      typeof account.client_id === "number" &&
      isRealNamedClientId(account.client_id, isMarker)
        ? account.client_id
        : null;
    const liveAssigned =
      liveClients.length === 1 ? liveClients[0]! : null;
    // D283 — live Smartlead null is authoritative for Onboarding-freed
    // PowerGRYD generics. Do not re-own them from leftover campaign links.
    const assignedClientId =
      mailboxClient ??
      (liveAssigned === powerId ? null : liveAssigned);
    const assignedCampaignIds = campaignIdsOf(withCampaigns).filter((id) => {
      const clientId = campaignClientById.get(id);
      return assignedClientId != null && clientId === assignedClientId;
    });
    const taggedPod = podFromMailboxTags(account.tags);
    const assignedPod =
      assignedClientId == null ? null : (taggedPod ?? existing?.assignedPod ?? null);
    const assignedAt =
      assignedClientId == null
        ? null
        : existing?.assignedClientId === assignedClientId && existing.assignedAt
          ? existing.assignedAt
          : now.toISOString();
    const pool = input.state.getPoolMailbox(email);
    if (mailboxClient != null) {
      realignStalePoolAssignment(input.state, email, mailboxClient, now);
    } else if (
      pool?.assignedClientId === powerId ||
      existing?.reason === GENERIC_ASSIGN_REASON_POWERGRYD ||
      existing?.assignedClientId === powerId
    ) {
      // D283 — clear stale powergryd_dedicated owner/reason.
      if (typeof input.state.upsertPoolMailbox === "function" && pool) {
        input.state.upsertPoolMailbox({
          ...pool,
          status: pool.status === "assigned" ? "available" : pool.status,
          assignedClientId: null,
          assignedClientName: undefined,
          assignedAt: undefined,
        });
      }
    }
    const warmReadyAt =
      existing?.warmReadyAt ??
      (typeof pool?.availableAt === "string" ? pool.availableAt : null) ??
      (typeof pool?.warmedAt === "string" ? pool.warmedAt : null);
    const warmupEnabled = mailboxWarmupIsOn(account);
    if (warmupEnabled === false) warmupOffEmails.push(email);
    if (assignedClientId == null && taggedPod != null) {
      unassignedWithPodTags.push(email);
    }
    const insightBlocked = isInsightClientId(assignedClientId);
    const seat = emptyGenericSeat(email, {
      slAccountId: typeof account.id === "number" ? account.id : existing?.slAccountId ?? null,
      provider: genericProviderFromAccountType(account.type),
      warmReadyAt,
      assignedClientId: insightBlocked ? null : assignedClientId,
      assignedCampaignIds: insightBlocked ? [] : assignedCampaignIds,
      assignedPod: insightBlocked ? null : assignedPod,
      assignedAt: insightBlocked ? null : assignedAt,
      reason: insightBlocked
        ? null
        : assignedReason(existing, assignedClientId, powerId, pocIds),
      releasedAt: existing?.releasedAt ?? null,
      releaseHistory: existing?.releaseHistory ?? [],
      staffableWeight: mailboxStaffableWeight(account),
      warmupEnabled,
      coveringFor: existing?.coveringFor ?? [],
    });
    const cleared =
      assignedClientId == null
        ? clearGenericAssignment({
            ...seat,
            slAccountId: seat.slAccountId,
            provider: seat.provider,
            warmReadyAt: seat.warmReadyAt,
          })
        : seat;
    nextSeats.push(mergeSeededGenericSeat(existing, cleared, now));
  }

  // Named seats without a POD tag take the static ESP-balanced A/B cut
  // so a missing tag cannot invent a 40-generic shortfall (D203/D221).
  for (const [clientKey, rows] of namedByClient) {
    const clientId = Number(clientKey);
    const untagged = rows.filter((row) => {
      const account = accountByEmail.get(row.email);
      return podFromMailboxTags(account?.tags) == null;
    });
    if (!untagged.length) continue;
    const cohorts = assignClientCohorts(untagged);
    for (const row of untagged) {
      const cohort = cohorts.get(row.email);
      const pod: GenericAssignedPod = cohort === "B" ? "B" : "A";
      const key = clientPodKey(clientId, pod);
      const account = accountByEmail.get(row.email);
      namedStaffableByClientPod.set(
        key,
        roundStaffableWeight(
          (namedStaffableByClientPod.get(key) ?? 0) +
            mailboxStaffableWeight(account ?? { type: row.type }),
        ),
      );
    }
  }

  const seenEmails = new Set(nextSeats.map((row) => row.email));
  for (const existing of existingByEmail.values()) {
    if (!existing.excluded || seenEmails.has(existing.email)) continue;
    nextSeats.push(
      emptyGenericSeat(existing.email, {
        ...existing,
        assignedClientId: null,
        assignedCampaignIds: [],
        assignedPod: null,
        assignedAt: null,
        coveringFor: [],
        excluded: true,
      }),
    );
  }

  const covered = alreadyCoveredEmails(nextSeats);
  const warmingByPod = warmingSeatsByClientPod(warmingBranded);
  const yieldCovering = createLoopYielder(GENERIC_SYNC_YIELD_EVERY);
  for (const seat of nextSeats) {
    await yieldCovering();
    if (seat.excluded || seat.assignedClientId == null || !seat.assignedPod) {
      seat.coveringFor = [];
      continue;
    }
    seat.coveringFor = linkCoveringFor({
      seat,
      warming: warmingBranded,
      warmingByPod,
      alreadyCovered: covered,
      now,
    });
    for (const row of seat.coveringFor) covered.add(row.email);
  }

  applyLedgerPins(nextSeats, warmingBranded);
  nextSeats.sort((a, b) => a.email.localeCompare(b.email));
  return {
    seats: nextSeats,
    namedStaffableByClientPod,
    clientHasActiveCampaign,
    campaignClientById,
    liveClientIdsByEmail,
    warmupOffEmails,
    unassignedWithPodTags,
    warmingBranded,
  };
}

export function genericPoolCanonCompliant(findings: string[]): boolean {
  return !findings.some((line) => {
    const kind = parseGenericPoolFinding(line).kind;
    return (
      kind === "generic_idle" ||
      kind === "generic_multi_client" ||
      kind === "generic_outside_table" ||
      kind === "generic_outside_ledger" ||
      kind === "generic_not_warming" ||
      kind === "generic_on_insight" ||
      kind === "pod_short_no_free_generic"
    );
  });
}
