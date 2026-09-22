import {
  accountEmail,
  campaignIdsOf,
  resolveAccountClient,
  type SmartleadAccountWithCampaigns,
  type SmartleadClientRecord,
} from "../clients/smartlead.js";
import type { AppConfig } from "../config.js";
import type { StateStore } from "../state/store.js";
import type { SmartleadCampaign, SmartleadEmailAccount } from "../types/index.js";
import { isClientInbox } from "./clientInbox.js";
import { senderIsAttachBlocked } from "./attachBlock.js";
import { isRetiredSendingDomain } from "./domainControl.js";
import { assignClientCohorts, onWeekCohort } from "./restCohort.js";
import { isStaffableSender } from "./staffableSender.js";
import { activeHoldUntilDate, tagNames } from "../services/warmupGate.js";

/**
 * D197 / D198 / D199 / D203 — every named-client POD keeps at least this
 * many *staffable* senders at **client inventory** (40 POD-A + 40 POD-B).
 * The on-week POD's 40 staff ACTIVE campaigns (fan-out); the off-week
 * POD's 40 rest ready. Cleanup / rest / one-client may only peel
 * surplus above it (dedicated named-client generics are not surplus).
 * Raw Smartlead membership (disconnected / resting / canary leftovers)
 * must not inflate the peel counter — that is how D197 still dropped
 * TechEvo / Parlay / Insight to 8 / 3 / 19 after a min-40 restaff.
 */
export const ON_WEEK_MIN_SENDERS = 40;

/** D203 — same 40, named at the POD inventory layer (not per-campaign). */
export const POD_INVENTORY_MIN_SENDERS = ON_WEEK_MIN_SENDERS;

/**
 * Exclusive client-signed generics this POD may still take from the
 * free pool (D203). Named first. Zero when named already ≥40 —
 * SalesGlider with ample salesglider* must not carry pool generics.
 */
export function podGenericTopUpCap(namedStaffableInPod: number): number {
  const named = Number.isFinite(namedStaffableInPod)
    ? Math.max(0, Math.floor(namedStaffableInPod))
    : 0;
  return Math.max(0, POD_INVENTORY_MIN_SENDERS - named);
}

/**
 * Operational named-client floor for one POD (D203):
 * max(named-in-pod structural rest, 40). Campaign attach is the
 * on-week POD's 40, not "40 unique senders per campaign".
 */
export function namedClientPodInventoryFloor(namedStaffableInPod: number): number {
  const named = Number.isFinite(namedStaffableInPod)
    ? Math.max(0, namedStaffableInPod)
    : 0;
  return Math.max(named, POD_INVENTORY_MIN_SENDERS);
}

export type PeelStaffableState = {
  getRestingInbox?: (email: string) => unknown;
  isCopyCanary?: (email: string) => boolean;
};

/**
 * Same eligibility the campaign floor / `/health` uses (D25 / D199).
 * Disconnected, resting, canary, and warmup-blocked seats do not staff.
 */
export function accountIsPeelStaffable(
  account: Pick<
    SmartleadEmailAccount,
    "is_smtp_success" | "is_imap_success" | "warmup_details"
  >,
  email: string,
  state: PeelStaffableState = {},
): boolean {
  const key = email.trim().toLowerCase();
  return isStaffableSender(account, {
    resting: Boolean(state.getRestingInbox?.(key)),
    copyCanary: Boolean(state.isCopyCanary?.(key)),
  });
}

/** Staffable attached count per campaign — the D199 peel floor input. */
export function countStaffableMemberships(
  accounts: SmartleadAccountWithCampaigns[],
  state: PeelStaffableState = {},
): Map<number, number> {
  const counts = new Map<number, number>();
  for (const account of accounts) {
    const email = accountEmail(account);
    if (!email || !accountIsPeelStaffable(account, email, state)) continue;
    for (const id of campaignIdsOf(account)) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Decrement the staffable peel counter only when the seat being
 * removed actually staffs. Peeling a disconnected leftover must not
 * unlock another live on-week seat.
 */
export function noteStaffableDetach(
  counts: Map<number, number>,
  campaignId: number,
  account: Pick<
    SmartleadEmailAccount,
    "is_smtp_success" | "is_imap_success" | "warmup_details"
  >,
  email: string,
  state: PeelStaffableState = {},
): void {
  if (!accountIsPeelStaffable(account, email, state)) return;
  counts.set(campaignId, Math.max(0, (counts.get(campaignId) ?? 0) - 1));
}

/**
 * True when taking one more *staffable* seat off this campaign would
 * break the standing 40 (D197/D199). `remainingBeforeDetach` is the
 * staffable attached count, never raw membership.
 * ACTIVE only — PAUSED/STOPPED hygiene (D169) still uses last-account.
 */
export function detachWouldBreakOnWeekMin(
  campaign: { status?: string | null } | undefined,
  remainingBeforeDetach: number,
): boolean {
  if (String(campaign?.status ?? "").toUpperCase() !== "ACTIVE") return false;
  return remainingBeforeDetach <= ON_WEEK_MIN_SENDERS;
}

/**
 * D199 — refuse only when the seat being removed is itself staffable
 * and the campaign is already at/under 40 staffable. Disconnected
 * leftovers may still come off; they do not staff the floor.
 */
export function detachWouldBreakStaffableFloor(
  campaign: { status?: string | null } | undefined,
  remainingStaffable: number,
  account: Pick<
    SmartleadEmailAccount,
    "is_smtp_success" | "is_imap_success" | "warmup_details"
  >,
  email: string,
  state: PeelStaffableState = {},
): boolean {
  if (!accountIsPeelStaffable(account, email, state)) return false;
  return detachWouldBreakOnWeekMin(campaign, remainingStaffable);
}

/**
 * D58 / D82 — even-split half of that client's own *named* inboxes.
 * Odd totals round down. No named-client exception (Vasco is not special).
 * D196 — live campaign floor is the on-week pod, not this half, when
 * ESP-balanced A/B (D192) leaves one cohort smaller than half.
 * D197 / D203 — never below the standing 40 per POD at inventory
 * (named + exclusive client-signed generics fill the shortfall).
 */
export function clientInboxStaffFloor(clientInboxCount: number): number {
  if (!Number.isFinite(clientInboxCount) || clientInboxCount <= 0) return 0;
  return Math.floor(clientInboxCount / 2);
}

export function clientCountKey(clientId: number | null | undefined): string {
  return typeof clientId === "number" && Number.isFinite(clientId)
    ? `id:${clientId}`
    : "unassigned";
}

export function allowsGenericStaff(
  campaign: { name?: string | null; client_id?: number | null },
  clientName: string | null | undefined,
  patterns: string[],
): boolean {
  const hay = `${campaign.name ?? ""} ${clientName ?? ""}`.toLowerCase();
  return patterns.some((pattern) => {
    const p = pattern.trim().toLowerCase();
    return Boolean(p) && hay.includes(p);
  });
}

type FloorCountState = Pick<StateStore, "getPoolMailbox"> & {
  isCopyCanary?: StateStore["isCopyCanary"];
  getDomainHistory?: StateStore["getDomainHistory"];
  listAttachBlocks?: StateStore["listAttachBlocks"];
  listIsolationActions?: StateStore["listIsolationActions"];
};

export interface ClientInboxFloorCounts {
  /** Eligible client inboxes (connected-capable, not generic / held / …). */
  eligible: Map<string, number>;
  /** On-week A/B pod size per client — the live staff floor (D196). */
  onWeek: Map<string, number>;
}

function eligibleClientInboxesByKey(
  accounts: SmartleadAccountWithCampaigns[],
  campaigns: SmartleadCampaign[],
  clients: SmartleadClientRecord[],
  config: Pick<AppConfig, "extraGenericMailboxes" | "extraGenericDomains" | "prewarmedDomains">,
  state: FloorCountState,
): Map<string, Array<{ email: string; type?: string | null }>> {
  const campaignClientById = new Map(
    campaigns.map((campaign) => [campaign.id, campaign.client_id]),
  );
  const clientsById = new Map(clients.map((client) => [client.id, client]));
  const byKey = new Map<string, Array<{ email: string; type?: string | null }>>();
  for (const account of accounts) {
    const email = accountEmail(account);
    if (!email) continue;
    if (!isClientInbox(account, email, config, state)) continue;
    // D99 — held / retired / canary boxes cannot staff a campaign. They
    // are not "A+B sitting" (D58) and must not inflate the floor.
    // A hold is the HOLD-UNTIL tag (D128) — fan-out refuses those boxes,
    // so a floor that counts them demands staffing nothing can deliver.
    if (state.isCopyCanary?.(email)) continue;
    if (activeHoldUntilDate(tagNames(account))) continue;
    const domain = email.split("@")[1]?.toLowerCase();
    const history = domain ? state.getDomainHistory?.(domain) : undefined;
    if (isRetiredSendingDomain(domain, history)) continue;
    if (
      senderIsAttachBlocked(
        { email, accountId: account.id, domain },
        state,
      )
    ) {
      continue;
    }
    const resolved = resolveAccountClient(account, campaignClientById, clientsById);
    const key = clientCountKey(resolved.clientId);
    const list = byKey.get(key) ?? [];
    list.push({ email, type: account.type });
    byKey.set(key, list);
  }
  return byKey;
}

/**
 * D58 / D82 / D196 / D203 — eligible *named* totals plus the on-week
 * pod per client. Generics stay out of this named count (`isClientInbox`);
 * they layer on top of each POD only for the shortfall-to-40 (D203
 * narrowing D193's "client-inbox only" read for the min-40 fill path).
 */
export function countClientInboxFloors(
  accounts: SmartleadAccountWithCampaigns[],
  campaigns: SmartleadCampaign[],
  clients: SmartleadClientRecord[],
  config: Pick<AppConfig, "extraGenericMailboxes" | "extraGenericDomains" | "prewarmedDomains">,
  state: FloorCountState,
  now: Date = new Date(),
): ClientInboxFloorCounts {
  const byKey = eligibleClientInboxesByKey(
    accounts,
    campaigns,
    clients,
    config,
    state,
  );
  const on = onWeekCohort(now);
  const eligible = new Map<string, number>();
  const onWeek = new Map<string, number>();
  for (const [key, rows] of byKey) {
    eligible.set(key, rows.length);
    const cohorts = assignClientCohorts(rows);
    let n = 0;
    for (const cohort of cohorts.values()) {
      if (cohort === on) n += 1;
    }
    onWeek.set(key, n);
  }
  return { eligible, onWeek };
}

export function countClientInboxesByKey(
  accounts: SmartleadAccountWithCampaigns[],
  campaigns: SmartleadCampaign[],
  clients: SmartleadClientRecord[],
  config: Pick<AppConfig, "extraGenericMailboxes" | "extraGenericDomains" | "prewarmedDomains">,
  state: FloorCountState,
): Map<string, number> {
  return countClientInboxFloors(accounts, campaigns, clients, config, state)
    .eligible;
}

export function countOnWeekClientInboxesByKey(
  accounts: SmartleadAccountWithCampaigns[],
  campaigns: SmartleadCampaign[],
  clients: SmartleadClientRecord[],
  config: Pick<AppConfig, "extraGenericMailboxes" | "extraGenericDomains" | "prewarmedDomains">,
  state: FloorCountState,
  now: Date = new Date(),
): Map<string, number> {
  return countClientInboxFloors(
    accounts,
    campaigns,
    clients,
    config,
    state,
    now,
  ).onWeek;
}

/**
 * Live staff floor for a named client campaign (D58/D82/D196/D197/D203).
 *
 * When `onWeekCounts` is provided (every production caller), the floor
 * is max(that client's named on-week pod, 40). That 40 is the on-week
 * POD's inventory cylinder (D203), not "40 unique senders on this
 * campaign". Understaffed means an on-week seat that should be attached
 * is missing, or that POD is under the standing 40. ESP-odd splits
 * (D192) can leave B smaller than half; that is not a short when the
 * pod itself is ≥40.
 *
 * Without `onWeekCounts`, falls back to half of `clientInboxCounts`
 * (unit tests / D58 Vasco "no exception" guard).
 */
export function staffFloorForCampaign(
  campaign: { name?: string | null; client_id?: number | null },
  clientInboxCounts: Map<string, number>,
  _clientName?: string | null,
  onWeekCounts?: Map<string, number>,
): number {
  const key = clientCountKey(campaign.client_id);
  if (onWeekCounts) {
    return Math.max(onWeekCounts.get(key) ?? 0, ON_WEEK_MIN_SENDERS);
  }
  return clientInboxStaffFloor(clientInboxCounts.get(key) ?? 0);
}

/** Hourly-check / audit copy: keep "half" only when the numbers match. */
export function formatStaffFloorDetail(
  serving: number,
  floor: number,
  eligibleCount: number,
): string {
  const half = clientInboxStaffFloor(eligibleCount);
  const label =
    floor === half
      ? "half this client's named inboxes (40/POD)"
      : floor === ON_WEEK_MIN_SENDERS && half < ON_WEEK_MIN_SENDERS
        ? "on-week minimum 40"
        : "on-week client pod";
  return `staffable ${serving}/${floor} (${label})`;
}
