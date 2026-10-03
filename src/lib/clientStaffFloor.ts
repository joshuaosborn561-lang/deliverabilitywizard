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
 * D197 / D198 / D199 / D207 / D209 — every ACTIVE campaign keeps at
 * least this many *staffable* senders from its own client (on-week
 * named first, then that client's generics, shared across that
 * client's ACTIVE campaigns). Cleanup / rest / one-client may only
 * peel surplus above it on an ACTIVE campaign. Raw Smartlead
 * membership (disconnected / canary leftovers) must not inflate the
 * peel counter. A rest *record* on a still-attached seat is not a
 * leftover and does not shrink the floor (D209). D203's 40-A + 40-B
 * named inventory split still stands; the live send floor is per
 * campaign (D207).
 */
export const ON_WEEK_MIN_SENDERS = 40;

/** D203 — named-split inventory cylinder. Live send floor is per campaign (D207). */
export const POD_INVENTORY_MIN_SENDERS = ON_WEEK_MIN_SENDERS;

/**
 * Exclusive client-signed generics this POD may still take from the
 * free pool (D203/D221). Named first. Zero when named already ≥40 —
 * SalesGlider with ample salesglider* must not carry pool generics.
 * A generic is assigned only while this cap is positive.
 */
export function podGenericTopUpCap(namedStaffableInPod: number): number {
  const named = Number.isFinite(namedStaffableInPod)
    ? Math.max(0, Math.floor(namedStaffableInPod))
    : 0;
  return Math.max(0, POD_INVENTORY_MIN_SENDERS - named);
}

/**
 * Operational named-client floor for one POD (D203):
 * max(named-in-pod structural rest, 40). Live attach (D207) is
 * 40 staffable senders on each ACTIVE campaign.
 */
export function namedClientPodInventoryFloor(namedStaffableInPod: number): number {
  const named = Number.isFinite(namedStaffableInPod)
    ? Math.max(0, namedStaffableInPod)
    : 0;
  return Math.max(named, POD_INVENTORY_MIN_SENDERS);
}

/**
 * D203 — per-POD ESP mix floor on top of D192. When the client has
 * both Outlook and Gmail, neither ESP may sit under ~1/3 of that
 * POD's seats (14 of a 40-seat POD). A one-ESP client is not
 * required to invent the other.
 */
export const POD_ESP_MIX_MIN_FRACTION = 1 / 3;

export function podEspMixMinSeats(
  podSeats: number = POD_INVENTORY_MIN_SENDERS,
): number {
  if (!Number.isFinite(podSeats) || podSeats <= 0) return 0;
  return Math.ceil(podSeats * POD_ESP_MIX_MIN_FRACTION);
}

export function podEspMixHolds(input: {
  outlook: number;
  gmail: number;
  clientHasBothEsps: boolean;
  podSeats?: number;
}): boolean {
  if (!input.clientHasBothEsps) return true;
  const outlook = Number.isFinite(input.outlook) ? Math.max(0, input.outlook) : 0;
  const gmail = Number.isFinite(input.gmail) ? Math.max(0, input.gmail) : 0;
  const podSeats =
    input.podSeats ?? Math.max(outlook + gmail, POD_INVENTORY_MIN_SENDERS);
  const floor = podEspMixMinSeats(podSeats);
  return outlook >= floor && gmail >= floor;
}

export type PeelStaffableState = {
  getRestingInbox?: (email: string) => unknown;
  isCopyCanary?: (email: string) => boolean;
};

/**
 * Same eligibility the campaign floor / `/health` uses (D25 / D199 / D209).
 * Disconnected, canary, and warmup-blocked seats do not staff.
 *
 * D209 — a rest *record* does not make an attached seat peel-exempt.
 * Client-rest used to `markRestingInbox` when the 40 floor blocked the
 * detach; the next pass then treated those still-attached seats as
 * non-staffable (`resting: true`) and peeled them below 40 (2026-09-29
 * BCP / Parlay / EMCOR). Only a successful detach benches a seat.
 * `getRestingInbox` stays on the state type for callers; peel-floor
 * counting ignores it.
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
 * break the standing 40 (D197/D199/D207). `remainingBeforeDetach` is
 * the staffable attached count, never raw membership.
 * ACTIVE only — PAUSED/STOPPED keep their senders (D207); last-account
 * still guards any detach that is allowed.
 */
export function detachWouldBreakOnWeekMin(
  campaign: { status?: string | null } | undefined,
  remainingBeforeDetach: number,
): boolean {
  if (String(campaign?.status ?? "").toUpperCase() !== "ACTIVE") return false;
  return remainingBeforeDetach <= ON_WEEK_MIN_SENDERS;
}

export type StaffableFloorDetachOpts = {
  /**
   * D207 — these seats may still come off an ACTIVE campaign at/under 40:
   * cross-client, HOLD/RETIRE-tagged, under-warmed (warmDays < 21).
   * Disconnected / SMTP-fail is already handled by accountIsPeelStaffable.
   */
  exempt?: boolean;
};

/** HOLD-UNTIL (unexpired) or a RETIRE tag — may peel below 40 (D207). */
export function hasHoldOrRetireTag(
  account: Pick<SmartleadEmailAccount, "tags">,
  now: Date = new Date(),
): boolean {
  const tags = (account.tags ?? [])
    .map((t) => String(t.tag_name ?? t.name ?? "").trim())
    .filter(Boolean);
  if (activeHoldUntilDate(tags, now)) return true;
  return tags.some((tag) => /\bRETIRE\b/i.test(tag));
}

/**
 * D199 / D207 — refuse only when the seat being removed is itself
 * staffable and the campaign is already at/under 40 staffable.
 * Disconnected leftovers, cross-client seats, HOLD/RETIRE-tagged
 * seats, and under-warmed seats may still come off.
 */
export function detachWouldBreakStaffableFloor(
  campaign: { status?: string | null } | undefined,
  remainingStaffable: number,
  account: Pick<
    SmartleadEmailAccount,
    "is_smtp_success" | "is_imap_success" | "warmup_details" | "tags"
  >,
  email: string,
  state: PeelStaffableState = {},
  opts: StaffableFloorDetachOpts = {},
): boolean {
  if (opts.exempt) return false;
  if (hasHoldOrRetireTag(account)) return false;
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
 * Live Canon / campaign-check floor (D217, superseding D196's
 * max(named on-week, 40) page floor).
 *
 * Every ACTIVE campaign pages only when on-week *staffable* senders
 * are under 40. Named on-week inventory can be 46 or 48 on an ESP-odd
 * split — that is not a short when the campaign already has ≥40
 * on-week staffable (SalesGlider 2026-10-03 false pages). Inventory
 * 40-A + 40-B (D203) is unchanged. `onWeekCounts` stays on the
 * signature so callers still pass the named split; the page floor
 * no longer rises with it.
 *
 * Without `onWeekCounts` (legacy unit tests / D58 Vasco guard) the
 * fallback is still half of `clientInboxCounts`.
 */
export function staffFloorForCampaign(
  campaign: { name?: string | null; client_id?: number | null },
  clientInboxCounts: Map<string, number>,
  _clientName?: string | null,
  onWeekCounts?: Map<string, number>,
): number {
  void _clientName;
  if (onWeekCounts) {
    return ON_WEEK_MIN_SENDERS;
  }
  return clientInboxStaffFloor(clientInboxCounts.get(clientCountKey(campaign.client_id)) ?? 0);
}

/** Hourly-check / audit copy: live floor is on-week staffable 40 (D217). */
export function formatStaffFloorDetail(
  serving: number,
  floor: number,
  eligibleCount: number,
): string {
  const half = clientInboxStaffFloor(eligibleCount);
  const label =
    floor === ON_WEEK_MIN_SENDERS
      ? "on-week staffable 40"
      : floor === half
        ? "half this client's named inboxes (40/POD)"
        : "on-week client pod";
  return `staffable ${serving}/${floor} (${label})`;
}
