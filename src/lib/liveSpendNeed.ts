/**
 * D296 — every domain / inbox buy prompt (Needs-you card, digest,
 * buy-resume) must be a legit, current need. Cover is one-per-source,
 * trigger seats must still exist in live Smartlead, client attribution
 * is the seat's client_id, announcements and InboxKit orders are
 * idempotent per domain, and approvals older than 48h do not execute.
 * Insight spend is Josh-only.
 */
import type { SmartleadAccountWithCampaigns } from "../clients/smartlead.js";
import type { SmartleadClientRecord } from "../clients/smartlead.js";
import { clientDisplayName } from "../clients/smartlead.js";
import { INSIGHT_CLIENT_ID } from "./insightCampaigns.js";
import type { IsolationActionRecord } from "../state/isolationState.js";
import type { SpendApprovalRecord, StateStore } from "../state/store.js";

export const SPEND_APPROVAL_TTL_MS = 48 * 60 * 60 * 1000;

export interface LiveSeat {
  email: string;
  clientId: number | null;
  clientName: string | null;
  inSmartlead: boolean;
  inInboxkit: boolean | null;
}

export interface SpendNeedLive {
  seats: Map<string, LiveSeat>;
  inboxkitDomains?: Set<string>;
  now?: Date;
}

export interface CoverHit {
  kind: "pending" | "live";
  domain: string;
  cover?: string;
  actionId?: string;
}

export function spendSourceDomain(
  detail: Record<string, unknown> | undefined,
): string {
  return String(detail?.retiredDomain ?? detail?.domain ?? "")
    .trim()
    .toLowerCase();
}

export function purchasedCoverDomains(
  detail: Record<string, unknown> | undefined,
): string[] {
  if (!Array.isArray(detail?.domains)) return [];
  return (detail.domains as unknown[])
    .map((row) => String(row).trim().toLowerCase())
    .filter(Boolean);
}

export function triggerEmailsOf(
  detail: Record<string, unknown> | undefined,
): string[] {
  const fromDetail = Array.isArray(detail?.failingEmails)
    ? (detail.failingEmails as unknown[])
    : Array.isArray(detail?.triggerEmails)
      ? (detail.triggerEmails as unknown[])
      : [];
  const listed = fromDetail
    .map((row) => String(row).trim().toLowerCase())
    .filter((email) => email.includes("@"));
  const single = String(detail?.triggerSeatEmail ?? "")
    .trim()
    .toLowerCase();
  if (single.includes("@") && !listed.includes(single)) listed.unshift(single);
  return listed;
}

export function clientIdOfSpendDetail(
  detail: Record<string, unknown> | undefined,
): number | null {
  const id = Number(
    detail?.triggerSeatClientId ??
      detail?.ownerClientId ??
      detail?.clientId,
  );
  return Number.isFinite(id) && id > 0 ? id : null;
}

export function isInsightClientId(id: number | null | undefined): boolean {
  return id === INSIGHT_CLIENT_ID;
}

export function isInsightSpendDetail(
  detail: Record<string, unknown> | undefined,
): boolean {
  return isInsightClientId(clientIdOfSpendDetail(detail));
}

export function approvalTimestamp(
  row: {
    decidedAt?: string;
    requestedAt?: string;
    executedAt?: string;
  },
): number {
  const raw = row.decidedAt ?? row.requestedAt ?? row.executedAt ?? "";
  const at = Date.parse(raw);
  return Number.isFinite(at) ? at : 0;
}

export function isFreshApproval(
  row: {
    decidedAt?: string;
    requestedAt?: string;
    executedAt?: string;
  },
  nowMs = Date.now(),
  ttlMs = SPEND_APPROVAL_TTL_MS,
): boolean {
  const at = approvalTimestamp(row);
  if (!at) return false;
  return nowMs - at <= ttlMs;
}

export function indexLiveSeats(
  accounts: Array<Pick<SmartleadAccountWithCampaigns, "from_email" | "email" | "username" | "client_id">>,
  clients: SmartleadClientRecord[] = [],
  inboxkitEmails?: Set<string>,
): Map<string, LiveSeat> {
  const names = new Map(
    clients.map((client) => [client.id, clientDisplayName(client)]),
  );
  const seats = new Map<string, LiveSeat>();
  for (const account of accounts) {
    const email = (
      account.from_email?.trim() ||
      account.email?.trim() ||
      account.username?.trim() ||
      ""
    ).toLowerCase();
    if (!email) continue;
    const clientId =
      typeof account.client_id === "number" && account.client_id > 0
        ? account.client_id
        : null;
    seats.set(email, {
      email,
      clientId,
      clientName: clientId ? (names.get(clientId) ?? `Client ${clientId}`) : null,
      inSmartlead: true,
      inInboxkit: inboxkitEmails ? inboxkitEmails.has(email) : null,
    });
  }
  return seats;
}

function coverStillLive(
  store: Pick<StateStore, "listPoolMailboxes">,
  cover: string,
  inboxkitDomains?: Set<string>,
): boolean {
  const host = cover.trim().toLowerCase();
  if (!host) return false;
  if (
    store
      .listPoolMailboxes()
      .some((row) => row.domain.toLowerCase() === host)
  ) {
    return true;
  }
  if (inboxkitDomains?.has(host)) return true;
  return false;
}

/**
 * True when this sending domain already has a pending, approved, or
 * live replacement cover. A live cover is a purchased domain that is
 * still in the pool or InboxKit, or a coverDomains stamp on history.
 */
export function domainHasLiveOrPendingCover(
  store: Pick<
    StateStore,
    "listIsolationActions" | "getDomainHistory" | "listPoolMailboxes"
  >,
  domain: string,
  opts?: { inboxkitDomains?: Set<string>; ignoreActionId?: string },
): CoverHit | null {
  const host = domain.trim().toLowerCase();
  if (!host) return null;
  const inboxkitDomains = opts?.inboxkitDomains;
  const ignore = opts?.ignoreActionId;
  for (const row of store.listIsolationActions()) {
    if (row.kind !== "buy_domains") continue;
    if (ignore && row.id === ignore) continue;
    if (
      row.status !== "pending" &&
      row.status !== "approved" &&
      row.status !== "executed"
    ) {
      continue;
    }
    if (spendSourceDomain(row.detail) !== host) continue;
    const covers = purchasedCoverDomains(row.detail);
    const live = covers.find((cover) =>
      coverStillLive(store, cover, inboxkitDomains),
    );
    if (live) {
      return {
        kind: "live",
        domain: host,
        cover: live,
        actionId: row.id,
      };
    }
    if (row.status === "pending" || row.status === "approved") {
      return {
        kind: "pending",
        domain: host,
        actionId: row.id,
        cover: covers[0],
      };
    }
    if (covers.length > 0) {
      return { kind: "live", domain: host, cover: covers[0], actionId: row.id };
    }
  }
  const stamped = store.getDomainHistory(host)?.coverDomains ?? [];
  for (const cover of stamped) {
    if (coverStillLive(store, cover, inboxkitDomains) || !inboxkitDomains) {
      return { kind: "live", domain: host, cover };
    }
  }
  return null;
}

export function persistCoverDomains(
  store: Pick<StateStore, "getDomainHistory" | "upsertDomainHistory">,
  sourceDomain: string,
  covers: string[],
): void {
  const host = sourceDomain.trim().toLowerCase();
  const nextCovers = [
    ...new Set(
      covers.map((row) => row.trim().toLowerCase()).filter(Boolean),
    ),
  ];
  if (!host || !nextCovers.length) return;
  const prev = store.getDomainHistory(host);
  const merged = [
    ...new Set([...(prev?.coverDomains ?? []), ...nextCovers]),
  ];
  store.upsertDomainHistory({
    domain: host,
    fleet: prev?.fleet ?? false,
    consecutiveFails: prev?.consecutiveFails ?? 0,
    status: prev?.status ?? "ok",
    readings: prev?.readings ?? [],
    lastReason: prev?.lastReason,
    skipCount: prev?.skipCount,
    retiredAt: prev?.retiredAt,
    coverDomains: merged,
    announcedKinds: prev?.announcedKinds,
  });
}

export function domainAlreadyAnnounced(
  store: Pick<StateStore, "getDomainHistory" | "listIsolationActions">,
  kind: string,
  domain: string,
): boolean {
  const host = domain.trim().toLowerCase();
  if (!host) return false;
  const stamped = store.getDomainHistory(host)?.announcedKinds ?? [];
  if (stamped.includes(kind)) return true;
  return store.listIsolationActions().some(
    (row) =>
      row.kind === kind &&
      spendSourceDomain(row.detail) === host &&
      row.detail.announced === true,
  );
}

export function markDomainAnnounced(
  store: Pick<
    StateStore,
    "getDomainHistory" | "upsertDomainHistory" | "getIsolationAction" | "upsertIsolationAction"
  >,
  kind: string,
  domain: string,
  actionId?: string,
): void {
  const host = domain.trim().toLowerCase();
  if (!host) return;
  const prev = store.getDomainHistory(host);
  const kinds = [...new Set([...(prev?.announcedKinds ?? []), kind])];
  store.upsertDomainHistory({
    domain: host,
    fleet: prev?.fleet ?? false,
    consecutiveFails: prev?.consecutiveFails ?? 0,
    status: prev?.status ?? "ok",
    readings: prev?.readings ?? [],
    lastReason: prev?.lastReason,
    skipCount: prev?.skipCount,
    retiredAt: prev?.retiredAt,
    coverDomains: prev?.coverDomains,
    announcedKinds: kinds,
  });
  if (!actionId) return;
  const action = store.getIsolationAction(actionId);
  if (!action) return;
  store.upsertIsolationAction({
    ...action,
    detail: { ...action.detail, announced: true },
  });
}

export function spendNeedReason(input: {
  kind: string;
  domain?: string;
  triggerEmails?: string[];
  proof?: string;
  podShortfall?: string;
  failure?: string;
}): string {
  if (input.podShortfall?.trim()) return input.podShortfall.trim();
  const emails = (input.triggerEmails ?? []).filter(Boolean);
  const host = (input.domain ?? "").trim().toLowerCase();
  if (emails.length) {
    const seats = emails.slice(0, 3).join(", ");
    const more = emails.length > 3 ? ` (+${emails.length - 3})` : "";
    if (input.kind === "retire_domain") {
      return `Retire ${host || "domain"} - trigger ${seats}${more} failed known-good.`;
    }
    if (input.kind === "buy_domains" || input.kind === "porkbun_domain") {
      return `Buy cover for ${host || "domain"} - trigger ${seats}${more} failed known-good.`;
    }
    if (input.kind === "inboxkit_mailbox_purchase") {
      return `Inboxes on ${host || "domain"} — trigger ${seats}${more}.`;
    }
    return `Trigger ${seats}${more} failed known-good${host ? ` on ${host}` : ""}.`;
  }
  if (input.failure?.trim()) return input.failure.trim();
  if (host && input.kind === "retire_domain") {
    return `Retire ${host} - domain failed known-good.`;
  }
  if (host && (input.kind === "buy_domains" || input.kind === "porkbun_domain")) {
    return `Buy cover for ${host} - domain failed known-good.`;
  }
  if (host && input.kind === "inboxkit_mailbox_purchase") {
    return `Buy inboxes on ${host}.`;
  }
  return (input.proof ?? "").split("\n")[0]?.trim() || "Current spend need.";
}

export type SpendNeedGoneReason =
  | "seat_gone"
  | "cover_exists"
  | "need_gone"
  | "insight_not_cayden"
  | "approval_expired";

export function liveTriggerSeats(
  emails: string[],
  live?: SpendNeedLive,
): LiveSeat[] {
  if (!live || live.seats.size === 0) return [];
  return emails
    .map((email) => live.seats.get(email.trim().toLowerCase()))
    .filter((row): row is LiveSeat => Boolean(row?.inSmartlead));
}

/**
 * A buy/retire whose trigger seats are gone from Smartlead is not a
 * current need. InboxKit-only leftovers do not keep it alive.
 * When no live snapshot is provided, the stored trigger client_id is
 * kept and the need is not dropped for missing seats.
 */
export function spendNeedDisappeared(
  input: {
    kind: string;
    detail: Record<string, unknown>;
    status?: string;
    id?: string;
  },
  store: Pick<
    StateStore,
    "listIsolationActions" | "getDomainHistory" | "listPoolMailboxes"
  >,
  live?: SpendNeedLive,
): { gone: boolean; why?: SpendNeedGoneReason; detail?: string } {
  const host = spendSourceDomain(input.detail);
  if (input.kind === "buy_domains" || input.kind === "porkbun_domain") {
    const cover = domainHasLiveOrPendingCover(store, host, {
      inboxkitDomains: live?.inboxkitDomains,
      ignoreActionId: input.id,
    });
    if (cover) {
      return {
        gone: true,
        why: "cover_exists",
        detail: cover.cover
          ? `${host} already has cover ${cover.cover}`
          : `${host} already has a ${cover.kind} cover`,
      };
    }
  }
  const emails = triggerEmailsOf(input.detail);
  if (live && live.seats.size > 0 && emails.length > 0) {
    const liveSeats = liveTriggerSeats(emails, live);
    if (!liveSeats.length) {
      return {
        gone: true,
        why: "seat_gone",
        detail: `Trigger seat ${emails[0]} is not in live Smartlead`,
      };
    }
  }
  return { gone: false };
}

export function clientAttributionFromSeats(
  seats: LiveSeat[],
  fallback?: { clientId?: number | null; clientName?: string | null },
): { clientId: number | null; clientName: string; clientKey: string } {
  const counted = new Map<number, { n: number; name: string }>();
  for (const seat of seats) {
    if (!seat.clientId) continue;
    const prev = counted.get(seat.clientId);
    counted.set(seat.clientId, {
      n: (prev?.n ?? 0) + 1,
      name: seat.clientName || prev?.name || `Client ${seat.clientId}`,
    });
  }
  const winner = [...counted.entries()].sort((a, b) => b[1].n - a[1].n)[0];
  if (winner) {
    return {
      clientId: winner[0],
      clientName: winner[1].name,
      clientKey: `id:${winner[0]}`,
    };
  }
  const id = fallback?.clientId ?? null;
  const name = (fallback?.clientName ?? "").trim();
  if (id && id > 0) {
    return {
      clientId: id,
      clientName: name || `Client ${id}`,
      clientKey: `id:${id}`,
    };
  }
  if (name) {
    return {
      clientId: null,
      clientName: name,
      clientKey: `name:${name.toLowerCase()}`,
    };
  }
  return { clientId: null, clientName: "Unassigned", clientKey: "unassigned" };
}

export function isolationMailboxOrderConsumed(
  store: Pick<StateStore, "listSpendApprovals" | "getLatestSpendApprovalForRequest">,
  key: string,
): boolean {
  const latest =
    store.getLatestSpendApprovalForRequest?.(key) ??
    store.listSpendApprovals().find((row) => (row.requestKey ?? row.id) === key);
  return latest?.status === "consumed";
}

export function expireStaleApprovals(
  store: Pick<
    StateStore,
    | "listIsolationActions"
    | "upsertIsolationAction"
    | "listSpendApprovals"
    | "upsertSpendApproval"
  >,
  now = new Date(),
): { isolation: number; spend: number } {
  const nowMs = now.getTime();
  let isolation = 0;
  let spend = 0;
  const stamp = now.toISOString();
  for (const action of store.listIsolationActions()) {
    if (action.status !== "approved") continue;
    if (action.executedAt) continue;
    // Domain already bought — mailbox resume must not wait on a fresh tap.
    if (purchasedCoverDomains(action.detail).length > 0) continue;
    if (String(action.detail.phase ?? "") === "awaiting_mailboxes") continue;
    if (isFreshApproval(action, nowMs)) continue;
    store.upsertIsolationAction({
      ...action,
      status: "pending",
      decidedAt: undefined,
      decidedBy: undefined,
      error: `Approval expired after 48h — needs a fresh tap (D296).`,
      detail: { ...action.detail, expiredAt: stamp },
    });
    isolation += 1;
  }
  for (const record of store.listSpendApprovals()) {
    if (record.status !== "approved") continue;
    const spendKey = record.requestKey ?? record.id;
    if (spendKey.startsWith("inboxkit:isolation:")) continue;
    if (isFreshApproval(record, nowMs)) continue;
    store.upsertSpendApproval({
      ...record,
      status: "pending",
      decidedAt: undefined,
      decidedBy: undefined,
      description: `${record.description} — approval expired after 48h (D296).`,
    } as SpendApprovalRecord);
    spend += 1;
  }
  return { isolation, spend };
}
