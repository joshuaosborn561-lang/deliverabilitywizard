import {
  accountEmail,
  resolveAccountClient,
  type SmartleadAccountWithCampaigns,
  type SmartleadClientRecord,
} from "../clients/smartlead.js";
import type { AppConfig } from "../config.js";
import type { StateStore } from "../state/store.js";
import type { SmartleadCampaign } from "../types/index.js";
import { isClientInbox } from "./clientInbox.js";
import { senderIsAttachBlocked } from "./attachBlock.js";
import { isRetiredSendingDomain } from "./domainControl.js";
import { assignClientCohorts, onWeekCohort } from "./restCohort.js";
import { activeHoldUntilDate, tagNames } from "../services/warmupGate.js";

/**
 * D58 / D82 — even-split half of that client's own inboxes.
 * Odd totals round down. No named-client exception (Vasco is not special).
 * D196 — live campaign floor is the on-week pod, not this half, when
 * ESP-balanced A/B (D192) leaves one cohort smaller than half.
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
 * D58 / D82 / D196 — eligible totals plus the on-week pod per client.
 * Generics stay out (`isClientInbox`); they are never backfill for a
 * named-client floor (D193).
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
 * Live staff floor for a named client campaign (D58/D82/D196).
 *
 * When `onWeekCounts` is provided (every production caller), the floor
 * is that client's on-week pod — understaffed means an on-week seat
 * that should be attached is missing. ESP-odd splits (D192) can leave
 * B smaller than half; that is not a short.
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
    return onWeekCounts.get(key) ?? 0;
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
    floor === half ? "half this client's inboxes" : "on-week client pod";
  return `staffable ${serving}/${floor} (${label})`;
}
