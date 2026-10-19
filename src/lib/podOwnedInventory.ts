/**
 * D285 — min-40 is per POD, not per campaign. Owned inventory is
 * client-owned named seats plus generics assigned to that client and
 * POD. Seats sitting on another named client's campaigns never count.
 */

import {
  accountEmail,
  campaignIdsOf,
  type SmartleadAccountWithCampaigns,
} from "../clients/smartlead.js";
import type { AppConfig } from "../config.js";
import type { StateStore } from "../state/store.js";
import type { SmartleadCampaign } from "../types/index.js";
import { isGabeVmReserved, isLockedCanarySeat } from "./canaryLock.js";
import { isAnyShellCampaign } from "./canaryShell.js";
import {
  callerFollowUpPolicyFromConfig,
  isCallerFollowUpCampaign,
} from "./callerFollowUp.js";
import { isGenericMailbox } from "./clientInbox.js";
import { clientNamedOwnerForDomain } from "./clientNamedDomain.js";
import { emailDomainOf } from "./isolationDomain.js";
import {
  accountIsPeelStaffable,
  hasHoldOrRetireTag,
} from "./clientStaffFloor.js";
import { isRealNamedClientId } from "./dedicatedGeneric.js";
import {
  displayShortfallSenders,
  displayStaffedSenders,
} from "./displaySenderCount.js";
import { clientPodKey, type GenericAssignedPod } from "./genericPool.js";
import {
  INSIGHT_CLIENT_ID,
  SALESGLIDER_CLIENT_ID,
  isInsightClientId,
  isInsightJoshAllowedSender,
  isInsightJoshOnlyCampaign,
} from "./insightCampaigns.js";
import { mailboxStaffableWeight, roundStaffableWeight } from "./mailboxType.js";
import { readMessagePerDay } from "./mailboxSendSettings.js";
import { minFloorForClient } from "./minFloorByClient.js";
import { mailboxPodOf, podInventoryNeed } from "./podInventory.js";
import { assignClientCohorts } from "./restCohort.js";
import { owesWarmup } from "../services/warmupGate.js";

export interface OwnedPodCount {
  clientId: number;
  pod: GenericAssignedPod;
  owned: number;
  named: number;
  generics: number;
  floor: number;
  shortBy: number;
}

export function seatSitsOnForeignNamedCampaign(input: {
  campaignIds: Iterable<number>;
  ownerClientId: number;
  campaignById: ReadonlyMap<
    number,
    { id?: number; client_id?: number | null; name?: string | null }
  >;
  isMarkerClientId?: (id: number | null | undefined) => boolean;
  /** Insight Josh leftover on SalesGlider is not a borrowed seat (D287). */
  ignoreForeignClientIds?: ReadonlySet<number>;
}): boolean {
  for (const id of input.campaignIds) {
    const campaign = input.campaignById.get(id);
    if (!campaign) continue;
    if (isAnyShellCampaign(campaign)) continue;
    if (isCallerFollowUpCampaign(campaign, callerFollowUpPolicyFromConfig())) {
      continue;
    }
    const cid = campaign.client_id;
    if (
      typeof cid === "number" &&
      isRealNamedClientId(cid, input.isMarkerClientId) &&
      cid !== input.ownerClientId &&
      !input.ignoreForeignClientIds?.has(cid)
    ) {
      return true;
    }
  }
  return false;
}

function sitsOnInsightCampaign(
  campaignIds: Iterable<number>,
  campaignById: ReadonlyMap<
    number,
    { id?: number; client_id?: number | null; name?: string | null }
  >,
): boolean {
  for (const id of campaignIds) {
    const campaign = campaignById.get(id);
    if (!campaign) continue;
    if (isInsightJoshOnlyCampaign(campaign) || isInsightClientId(campaign.client_id)) {
      return true;
    }
  }
  return false;
}

/**
 * D287 — owner for the POD-40 count. Insight Josh seats count for
 * Insight even when Smartlead still has SalesGlider 345263. Named
 * seats with a missing client_id fall back to the sending-domain
 * slug (Peterson roofs*, PowerGRYD, …).
 */
export function ownedNamedClientIdForSeat(input: {
  account: {
    client_id?: number | null;
    from_name?: string | null;
    from_email?: string | null;
    email?: string | null;
    username?: string | null;
    signature?: string | null;
  };
  email: string;
  campaignIds: Iterable<number>;
  campaignById: ReadonlyMap<
    number,
    { id?: number; client_id?: number | null; name?: string | null }
  >;
  isMarkerClientId?: (id: number | null | undefined) => boolean;
}): number | null {
  const liveId =
    typeof input.account.client_id === "number" &&
    isRealNamedClientId(input.account.client_id, input.isMarkerClientId)
      ? input.account.client_id
      : null;
  if (isInsightJoshAllowedSender(input.account)) {
    const domain = emailDomainOf(input.email) ?? "";
    const insightDomain =
      /joshosborn/i.test(domain) || /insight/i.test(domain);
    if (
      isInsightClientId(liveId) ||
      insightDomain ||
      sitsOnInsightCampaign(input.campaignIds, input.campaignById)
    ) {
      return INSIGHT_CLIENT_ID;
    }
  }
  if (liveId != null) return liveId;
  const domainOwner = clientNamedOwnerForDomain(emailDomainOf(input.email));
  if (
    domainOwner &&
    isRealNamedClientId(domainOwner.clientId, input.isMarkerClientId)
  ) {
    return domainOwner.clientId;
  }
  return null;
}

function warmupConfigOf(
  config: Pick<
    AppConfig,
    | "campaignMinWarmupDays"
    | "freshInboxWarmupDays"
    | "prewarmedDomains"
    | "extraGenericMailboxes"
  >,
) {
  return {
    campaignMinWarmupDays: config.campaignMinWarmupDays ?? 21,
    freshInboxWarmupDays: config.freshInboxWarmupDays ?? 21,
    prewarmedDomains: config.prewarmedDomains,
    extraGenericMailboxes: config.extraGenericMailboxes,
  };
}

export function seatIsWarmStaffableForPod(input: {
  account: SmartleadAccountWithCampaigns;
  email: string;
  config: Pick<
    AppConfig,
    | "campaignMinWarmupDays"
    | "freshInboxWarmupDays"
    | "prewarmedDomains"
    | "extraGenericMailboxes"
  >;
  state: Pick<
    StateStore,
    | "getPoolMailbox"
    | "isCopyCanary"
    | "getRestingInbox"
    | "isInboxKitEndingSoon"
  >;
  now?: Date;
}): boolean {
  const { account, email, config, state } = input;
  const key = email.trim().toLowerCase();
  if (!key) return false;
  if (isLockedCanarySeat(account, key, state)) return false;
  if (isGabeVmReserved(account)) return false;
  if (hasHoldOrRetireTag(account, input.now)) return false;
  if (
    typeof state.isInboxKitEndingSoon === "function" &&
    state.isInboxKitEndingSoon(key)
  ) {
    return false;
  }
  if (!accountIsPeelStaffable(account, key, state)) return false;
  if (owesWarmup(account, key, warmupConfigOf(config), state)) return false;
  const mpd = readMessagePerDay(account);
  if (Number.isFinite(mpd) && mpd <= 0) return false;
  return true;
}

export function formatPodUnderstaffedDetail(
  row: OwnedPodCount,
  clientName?: string,
): string {
  const owned = displayStaffedSenders(row.owned);
  const short = displayShortfallSenders(row.shortBy);
  const who = clientName ? `${clientName} ` : "";
  return `${who}POD-${row.pod} owned ${owned}/${row.floor} (short ${short})`;
}

export function formatPodFloorAlert(
  row: OwnedPodCount,
  clientName: string,
): string {
  const owned = displayStaffedSenders(row.owned);
  const short = displayShortfallSenders(row.shortBy);
  return `${clientName} POD-${row.pod} is under floor: owned ${owned}, need ${row.floor} (short ${short}).`;
}

/**
 * Weighted owned staffable seats per named-client POD (D285).
 * Named Insight seats are Josh-only. Borrowed seats (on another
 * named client's campaigns) are ignored.
 */
export function countOwnedClientPods(input: {
  accounts: SmartleadAccountWithCampaigns[];
  campaigns: Iterable<SmartleadCampaign>;
  config: Pick<
    AppConfig,
    | "campaignMinWarmupDays"
    | "freshInboxWarmupDays"
    | "prewarmedDomains"
    | "extraGenericMailboxes"
    | "extraGenericDomains"
    | "minFloorByClient"
  >;
  state: Pick<
    StateStore,
    | "getPoolMailbox"
    | "isCopyCanary"
    | "getRestingInbox"
    | "isInboxKitEndingSoon"
    | "isMarkerClientId"
    | "getGenericSeat"
    | "listGenericSeats"
  >;
  clientIds: Iterable<number>;
  now?: Date;
}): OwnedPodCount[] {
  const now = input.now ?? new Date();
  const isMarker = input.state.isMarkerClientId?.bind(input.state);
  const campaignById = new Map<number, SmartleadCampaign>();
  for (const campaign of input.campaigns) {
    if (typeof campaign.id === "number") campaignById.set(campaign.id, campaign);
  }
  const wanted = new Set(
    [...input.clientIds].filter((id) => isRealNamedClientId(id, isMarker)),
  );
  const namedByClient = new Map<
    number,
    Array<{ email: string; account: SmartleadAccountWithCampaigns }>
  >();
  const genericRows: Array<{
    email: string;
    account: SmartleadAccountWithCampaigns;
    clientId: number;
    pod: GenericAssignedPod | null;
  }> = [];

  for (const account of input.accounts) {
    const email = accountEmail(account)?.toLowerCase();
    if (!email) continue;
    if (
      !seatIsWarmStaffableForPod({
        account,
        email,
        config: input.config,
        state: input.state,
        now,
      })
    ) {
      continue;
    }
    const generic = isGenericMailbox(account, email, input.config, input.state);
    if (generic) {
      const table = input.state.getGenericSeat(email);
      const liveId =
        typeof account.client_id === "number" &&
        isRealNamedClientId(account.client_id, isMarker)
          ? account.client_id
          : null;
      const assigned =
        liveId ??
        (typeof table?.assignedClientId === "number" &&
        isRealNamedClientId(table.assignedClientId, isMarker)
          ? table.assignedClientId
          : null);
      if (assigned == null || !wanted.has(assigned)) continue;
      if (
        seatSitsOnForeignNamedCampaign({
          campaignIds: campaignIdsOf(account),
          ownerClientId: assigned,
          campaignById,
          isMarkerClientId: isMarker,
        })
      ) {
        continue;
      }
      genericRows.push({
        email,
        account,
        clientId: assigned,
        pod: table?.assignedPod ?? mailboxPodOf(account),
      });
      continue;
    }
    const clientId = ownedNamedClientIdForSeat({
      account,
      email,
      campaignIds: campaignIdsOf(account),
      campaignById,
      isMarkerClientId: isMarker,
    });
    if (clientId == null || !wanted.has(clientId)) continue;
    if (isInsightClientId(clientId) && !isInsightJoshAllowedSender(account)) {
      continue;
    }
    const ignoreForeign = isInsightClientId(clientId)
      ? new Set([SALESGLIDER_CLIENT_ID])
      : undefined;
    if (
      seatSitsOnForeignNamedCampaign({
        campaignIds: campaignIdsOf(account),
        ownerClientId: clientId,
        campaignById,
        isMarkerClientId: isMarker,
        ignoreForeignClientIds: ignoreForeign,
      })
    ) {
      continue;
    }
    const list = namedByClient.get(clientId) ?? [];
    list.push({ email, account });
    namedByClient.set(clientId, list);
  }

  const namedWeight = new Map<string, number>();
  for (const [clientId, rows] of namedByClient) {
    const tagged = new Map<string, GenericAssignedPod>();
    const untagged: Array<{ email: string; type?: string | null }> = [];
    for (const row of rows) {
      const pod = mailboxPodOf(row.account);
      if (pod) tagged.set(row.email, pod);
      else untagged.push({ email: row.email, type: row.account.type });
    }
    const cohorts = assignClientCohorts(untagged);
    for (const row of rows) {
      const pod =
        tagged.get(row.email) ??
        (cohorts.get(row.email) === "B" ? "B" : "A");
      const key = clientPodKey(clientId, pod);
      namedWeight.set(
        key,
        roundStaffableWeight(
          (namedWeight.get(key) ?? 0) + mailboxStaffableWeight(row.account),
        ),
      );
    }
  }

  const genericWeight = new Map<string, number>();
  const untaggedGenerics = new Map<
    number,
    Array<{ email: string; type?: string | null; account: SmartleadAccountWithCampaigns }>
  >();
  for (const row of genericRows) {
    if (row.pod === "A" || row.pod === "B") {
      const key = clientPodKey(row.clientId, row.pod);
      genericWeight.set(
        key,
        roundStaffableWeight(
          (genericWeight.get(key) ?? 0) + mailboxStaffableWeight(row.account),
        ),
      );
      continue;
    }
    const list = untaggedGenerics.get(row.clientId) ?? [];
    list.push({ email: row.email, type: row.account.type, account: row.account });
    untaggedGenerics.set(row.clientId, list);
  }
  for (const [clientId, rows] of untaggedGenerics) {
    const cohorts = assignClientCohorts(
      rows.map((row) => ({ email: row.email, type: row.type })),
    );
    for (const row of rows) {
      const pod: GenericAssignedPod = cohorts.get(row.email) === "B" ? "B" : "A";
      const key = clientPodKey(clientId, pod);
      genericWeight.set(
        key,
        roundStaffableWeight(
          (genericWeight.get(key) ?? 0) + mailboxStaffableWeight(row.account),
        ),
      );
    }
  }

  const out: OwnedPodCount[] = [];
  for (const clientId of wanted) {
    const floor = minFloorForClient(clientId, input.config.minFloorByClient);
    for (const pod of ["A", "B"] as const) {
      const key = clientPodKey(clientId, pod);
      const named = namedWeight.get(key) ?? 0;
      const generics = genericWeight.get(key) ?? 0;
      const owned = roundStaffableWeight(named + generics);
      out.push({
        clientId,
        pod,
        owned,
        named,
        generics,
        floor,
        shortBy: podInventoryNeed(owned, 0, floor),
      });
    }
  }
  return out.sort(
    (a, b) => a.clientId - b.clientId || a.pod.localeCompare(b.pod),
  );
}

export function ownedPodMap(
  rows: Iterable<OwnedPodCount>,
): Map<string, OwnedPodCount> {
  const out = new Map<string, OwnedPodCount>();
  for (const row of rows) out.set(clientPodKey(row.clientId, row.pod), row);
  return out;
}
