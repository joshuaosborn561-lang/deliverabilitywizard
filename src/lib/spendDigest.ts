/**
 * D220 — weekday Cayden per-client spend digest.
 *
 * Pending domain / inbox buys and Retire covers live in spendApprovals
 * and isolation.actions. This gathers that existing state, drops stale
 * or already-resolved rows, and groups the rest so each client is one
 * approval in a single Slack post. It does not spend, approve, or
 * invent a new spend path.
 */
import {
  dismissRetiredDomainAsks,
  domainAlreadyRetired,
  domainRetireReplacementSpent,
  healStaleBurnAsks,
  isBurnAskKind,
  retireAlreadySettled,
} from "./isolationActions.js";
import {
  clientAttributionFromSeats,
  clientIdOfSpendDetail,
  expireStaleApprovals,
  isInsightClientId,
  liveTriggerSeats,
  spendNeedDisappeared,
  spendNeedReason,
  triggerEmailsOf,
  type SpendNeedLive,
} from "./liveSpendNeed.js";
import { pruneSatisfiedPendingSpend } from "./pendingSpendPrune.js";
import type { IsolationActionRecord } from "../state/isolationState.js";
import type { SpendApprovalRecord, StateStore } from "../state/store.js";

export const SPEND_DIGEST_KINDS = [
  "retire_domain",
  "buy_domains",
  "porkbun_domain",
  "inboxkit_mailbox_purchase",
] as const;

export type SpendDigestKind = (typeof SPEND_DIGEST_KINDS)[number];

export interface SpendDigestItem {
  source: "isolation" | "spend";
  id: string;
  kind: SpendDigestKind;
  label: string;
  reason?: string;
  domain?: string;
  clientKey: string;
  clientName: string;
  requestedAt: string;
  joshOnly?: boolean;
}

export interface SpendDigestClientGroup {
  clientKey: string;
  clientName: string;
  items: SpendDigestItem[];
}

const SPEND_KIND_SET = new Set<string>(SPEND_DIGEST_KINDS);

export function isSpendDigestKind(kind: string): kind is SpendDigestKind {
  return SPEND_KIND_SET.has(kind);
}

function clientOfDetail(
  detail: Record<string, unknown>,
  live?: SpendNeedLive,
): {
  clientKey: string;
  clientName: string;
  clientId: number | null;
} {
  const liveSeats = liveTriggerSeats(triggerEmailsOf(detail), live);
  const fallbackId = clientIdOfSpendDetail(detail);
  const fallbackName =
    typeof detail.ownerClientName === "string"
      ? detail.ownerClientName.trim()
      : typeof detail.clientName === "string"
        ? detail.clientName.trim()
        : "";
  const attr = clientAttributionFromSeats(liveSeats, {
    clientId: fallbackId,
    clientName: fallbackName,
  });
  if (attr.clientKey === "unassigned") {
    if (String(detail.ownerKind ?? "") === "generic") {
      return {
        clientKey: "generic-pool",
        clientName: "Generic pool",
        clientId: null,
      };
    }
  }
  return attr;
}

function itemReason(
  kind: string,
  detail: Record<string, unknown>,
  fallback: string,
): string {
  return spendNeedReason({
    kind,
    domain: domainOf(detail),
    triggerEmails: triggerEmailsOf(detail),
    proof: fallback,
    podShortfall:
      typeof detail.podShortfall === "string" ? detail.podShortfall : undefined,
    failure: typeof detail.failure === "string" ? detail.failure : undefined,
  });
}

function domainOf(detail: Record<string, unknown>): string {
  return String(detail.domain ?? detail.retiredDomain ?? "")
    .trim()
    .toLowerCase();
}

function isolationLabel(action: IsolationActionRecord, reason: string): string {
  const host = domainOf(action.detail);
  const base =
    action.kind === "retire_domain"
      ? host
        ? `Retire ${host}`
        : action.title
      : action.kind === "buy_domains"
        ? host
          ? `Buy cover for ${host}`
          : action.title
        : action.title;
  if (!reason || reason === base) return base;
  if (
    reason.startsWith("Retire ") ||
    reason.startsWith("Buy cover for ") ||
    reason.startsWith("Buy inboxes")
  ) {
    return reason;
  }
  return `${base} - ${reason}`;
}

function spendLabel(record: SpendApprovalRecord): string {
  if (record.description.trim()) return record.description.trim();
  const host = domainOf(record.detail);
  if (record.kind === "porkbun_domain") {
    return host ? `Buy domain ${host}` : "Buy a domain";
  }
  if (record.kind === "inboxkit_mailbox_purchase") {
    return host ? `Buy inboxes on ${host}` : "Buy inboxes";
  }
  return record.kind;
}

function isolationStillPending(
  store: Pick<
    StateStore,
    "listIsolationActions" | "getDomainHistory" | "getAttachBlock"
  >,
  action: IsolationActionRecord,
): boolean {
  if (action.status !== "pending") return false;
  if (!isBurnAskKind(action.kind)) return false;
  const host = domainOf(action.detail);
  if (host && domainAlreadyRetired(store, host)) return false;
  if (host && retireAlreadySettled(store, host)) return false;
  if (host && domainRetireReplacementSpent(store, host)) return false;
  if (host && store.getAttachBlock?.(host)?.reason === "burned") return false;
  if (
    host &&
    action.kind === "retire_domain" &&
    store.listIsolationActions().some(
      (row) =>
        row.id !== action.id &&
        row.kind === "retire_domain" &&
        domainOf(row.detail) === host &&
        (row.status === "approved" || row.status === "executed"),
    )
  ) {
    return false;
  }
  return true;
}

export function collectPendingSpendItems(
  store: Pick<
    StateStore,
    | "listIsolationActions"
    | "listSpendApprovals"
    | "getDomainHistory"
    | "upsertIsolationAction"
    | "upsertSpendApproval"
    | "listPoolMailboxes"
    | "getAttachBlock"
  >,
  live?: SpendNeedLive,
): SpendDigestItem[] {
  expireStaleApprovals(store, live?.now ?? new Date());
  dismissRetiredDomainAsks(store);
  healStaleBurnAsks(store);
  pruneSatisfiedPendingSpend(
    store,
    (live?.now ?? new Date()).toISOString(),
    live,
  );

  const items: SpendDigestItem[] = [];
  const seen = new Set<string>();

  for (const action of store.listIsolationActions()) {
    if (!isSpendDigestKind(action.kind)) continue;
    if (!isolationStillPending(store, action)) continue;
    const disappeared = spendNeedDisappeared(action, store, live);
    if (disappeared.gone) continue;
    const client = clientOfDetail(action.detail, live);
    const host = domainOf(action.detail);
    const dedupe = `${action.kind}:${host || action.id}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const reason = itemReason(action.kind, action.detail, action.proof);
    items.push({
      source: "isolation",
      id: action.id,
      kind: action.kind,
      label: isolationLabel(action, reason),
      reason,
      domain: host || undefined,
      clientKey: client.clientKey,
      clientName: client.clientName,
      requestedAt: action.requestedAt,
      joshOnly: isInsightClientId(client.clientId),
    });
  }

  for (const record of store.listSpendApprovals()) {
    if (record.status !== "pending" || !isSpendDigestKind(record.kind)) continue;
    const disappeared = spendNeedDisappeared(
      {
        kind: record.kind,
        detail: record.detail ?? {},
        status: record.status,
        id: record.id,
      },
      store,
      live,
    );
    if (disappeared.gone) continue;
    const host = domainOf(record.detail);
    const dedupe = `${record.kind}:${host || record.id}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const client = clientOfDetail(record.detail ?? {}, live);
    const reason = itemReason(
      record.kind,
      record.detail ?? {},
      record.description,
    );
    items.push({
      source: "spend",
      id: record.id,
      kind: record.kind,
      label: record.description.trim() || reason || spendLabel(record),
      reason,
      domain: host || undefined,
      clientKey: client.clientKey,
      clientName: client.clientName,
      requestedAt: record.requestedAt,
      joshOnly: isInsightClientId(client.clientId),
    });
  }

  items.sort((a, b) => {
    const client = a.clientName.localeCompare(b.clientName);
    if (client !== 0) return client;
    return a.requestedAt.localeCompare(b.requestedAt);
  });
  return items;
}

export function groupSpendItemsByClient(
  items: SpendDigestItem[],
): SpendDigestClientGroup[] {
  const byKey = new Map<string, SpendDigestClientGroup>();
  for (const item of items) {
    if (item.joshOnly) continue;
    const existing = byKey.get(item.clientKey);
    if (existing) {
      existing.items.push(item);
      continue;
    }
    byKey.set(item.clientKey, {
      clientKey: item.clientKey,
      clientName: item.clientName,
      items: [item],
    });
  }
  return [...byKey.values()].sort((a, b) =>
    a.clientName.localeCompare(b.clientName),
  );
}

/** One Slack body. Empty when nothing is waiting. No em dashes. */
export function spendDigestText(groups: SpendDigestClientGroup[]): string | null {
  if (!groups.length) return null;
  const lines = [
    "*Cayden spend digest* - one approval per client. Pending domain / inbox buys and Retire covers.",
    "",
  ];
  for (const group of groups) {
    lines.push(`*${group.clientName}*`);
    for (const item of group.items) {
      lines.push(`• ${item.label}`);
    }
    lines.push("");
  }
  lines.push(
    "Each client above is one approval. Tap the existing Retire / Buy cards in this channel. Nothing is bought until you confirm.",
  );
  return lines.join("\n").trim();
}

export function buildCaydenSpendDigest(
  store: Pick<
    StateStore,
    | "listIsolationActions"
    | "listSpendApprovals"
    | "getDomainHistory"
    | "upsertIsolationAction"
    | "upsertSpendApproval"
    | "listPoolMailboxes"
    | "getAttachBlock"
  >,
  live?: SpendNeedLive,
): { groups: SpendDigestClientGroup[]; text: string | null; items: number } {
  const items = collectPendingSpendItems(store, live);
  const groups = groupSpendItemsByClient(items);
  return { groups, text: spendDigestText(groups), items: items.length };
}
