import { accountEmail, campaignIdsOf } from "../clients/smartlead.js";
import type { SmartleadAccountWithCampaigns } from "../clients/smartlead.js";
import type { AppConfig } from "../config.js";
import type { StateStore } from "../state/store.js";
import type { SmartleadEmailAccount } from "../types/index.js";
import {
  isGabeVmReserved,
  isLockedCanarySeat,
} from "./canaryLock.js";
import { isClientInbox, isGenericMailbox } from "./clientInbox.js";
import { owesWarmup } from "../services/warmupGate.js";
import { isRealNamedClientId } from "./dedicatedGeneric.js";
import { assignClientCohorts } from "./restCohort.js";
import { isStaffableSender } from "./staffableSender.js";
import { rankGenericsOldestWorstFirst } from "./genericAssign.js";
import { mailboxStaffableWeight, roundStaffableWeight } from "./mailboxType.js";
import { isGabeFollowUpCampaign } from "./pocClient.js";
import { pickWeightedGenericReturns } from "./namedWarmSwap.js";
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
          : `assigned to client ${clientId} POD ${pod} but is not needed to reach ${40} (named ${named}, assigned ${assignedWeight})`;
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

/**
 * Rebuild the generics table from the shared Smartlead inventory.
 * Assignment is whoever currently has the seat (client_id / campaigns);
 * the validator then decides whether that assignment is still needed.
 */
export function syncGenericSeatsFromInventory(
  input: GenericPoolSyncInput,
): GenericPoolSyncResult {
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

  for (const account of input.accounts) {
    const email = accountEmail(account);
    if (!email) continue;
    if (isLockedCanarySeat(account, email, input.state)) continue;
    const withCampaigns = account as SmartleadAccountWithCampaigns;
    const generic = isGenericMailbox(account, email, input.config, input.state);
    if (!generic) {
      if (
        !isClientInbox(account, email, input.config, input.state) ||
        isGabeVmReserved(account) ||
        !isStaffableSender(account, {
          copyCanary: Boolean(input.state.isCopyCanary?.(email)),
        }) ||
        owesWarmup(
          account as SmartleadAccountWithCampaigns,
          email,
          {
            campaignMinWarmupDays: input.config.campaignMinWarmupDays ?? 21,
            freshInboxWarmupDays: input.config.freshInboxWarmupDays ?? 21,
            prewarmedDomains: input.config.prewarmedDomains,
            extraGenericMailboxes: input.config.extraGenericMailboxes,
          },
          input.state,
        )
      ) {
        continue;
      }
      const clientId =
        typeof account.client_id === "number" &&
        isRealNamedClientId(account.client_id, isMarker)
          ? account.client_id
          : null;
      if (clientId == null) continue;
      const list = namedByClient.get(String(clientId)) ?? [];
      list.push({
        email,
        type: account.type,
      });
      namedByClient.set(String(clientId), list);
      const tagged = podFromMailboxTags(account.tags);
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
    const assignedClientId =
      mailboxClient ?? (liveClients.length === 1 ? liveClients[0]! : null);
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
    const warmReadyAt =
      existing?.warmReadyAt ??
      (typeof pool?.availableAt === "string" ? pool.availableAt : null) ??
      (typeof pool?.warmedAt === "string" ? pool.warmedAt : null);

    const seat = emptyGenericSeat(email, {
      slAccountId: typeof account.id === "number" ? account.id : existing?.slAccountId ?? null,
      provider: genericProviderFromAccountType(account.type),
      warmReadyAt,
      assignedClientId,
      assignedCampaignIds,
      assignedPod,
      assignedAt,
      reason: assignedReason(existing, assignedClientId, powerId, pocIds),
      releasedAt: existing?.releasedAt ?? null,
      releaseHistory: existing?.releaseHistory ?? [],
      staffableWeight: mailboxStaffableWeight(account),
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
      const account = input.accounts.find(
        (item) => accountEmail(item) === row.email,
      );
      return podFromMailboxTags(account?.tags) == null;
    });
    if (!untagged.length) continue;
    const cohorts = assignClientCohorts(untagged);
    for (const row of untagged) {
      const cohort = cohorts.get(row.email);
      const pod: GenericAssignedPod = cohort === "B" ? "B" : "A";
      const key = clientPodKey(clientId, pod);
      const account = input.accounts.find(
        (item) => accountEmail(item) === row.email,
      );
      namedStaffableByClientPod.set(
        key,
        roundStaffableWeight(
          (namedStaffableByClientPod.get(key) ?? 0) +
            mailboxStaffableWeight(account ?? { type: row.type }),
        ),
      );
    }
  }

  nextSeats.sort((a, b) => a.email.localeCompare(b.email));
  return {
    seats: nextSeats,
    namedStaffableByClientPod,
    clientHasActiveCampaign,
    campaignClientById,
    liveClientIdsByEmail,
  };
}

export function genericPoolCanonCompliant(findings: string[]): boolean {
  return !findings.some((line) => {
    const kind = parseGenericPoolFinding(line).kind;
    return (
      kind === "generic_idle" ||
      kind === "generic_multi_client" ||
      kind === "generic_outside_table"
    );
  });
}
