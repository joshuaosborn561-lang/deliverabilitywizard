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
  domain?: string;
  clientKey: string;
  clientName: string;
  requestedAt: string;
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

function clientOfIsolation(action: IsolationActionRecord): {
  clientKey: string;
  clientName: string;
} {
  const id = Number(action.detail.ownerClientId);
  const name =
    typeof action.detail.ownerClientName === "string"
      ? action.detail.ownerClientName.trim()
      : "";
  if (Number.isFinite(id) && id > 0) {
    return { clientKey: `id:${id}`, clientName: name || `Client ${id}` };
  }
  if (name) return { clientKey: `name:${name.toLowerCase()}`, clientName: name };
  if (String(action.detail.ownerKind ?? "") === "generic") {
    return { clientKey: "generic-pool", clientName: "Generic pool" };
  }
  return { clientKey: "unassigned", clientName: "Unassigned" };
}

function clientOfSpend(record: SpendApprovalRecord): {
  clientKey: string;
  clientName: string;
} {
  const detail = record.detail ?? {};
  const id = Number(detail.clientId ?? detail.ownerClientId);
  const name = String(
    detail.clientName ?? detail.ownerClientName ?? "",
  ).trim();
  if (Number.isFinite(id) && id > 0) {
    return { clientKey: `id:${id}`, clientName: name || `Client ${id}` };
  }
  if (name) return { clientKey: `name:${name.toLowerCase()}`, clientName: name };
  return { clientKey: "unassigned", clientName: "Unassigned" };
}

function domainOf(detail: Record<string, unknown>): string {
  return String(detail.domain ?? detail.retiredDomain ?? "")
    .trim()
    .toLowerCase();
}

function isolationLabel(action: IsolationActionRecord): string {
  const host = domainOf(action.detail);
  if (action.kind === "retire_domain") {
    return host ? `Retire ${host}` : action.title;
  }
  if (action.kind === "buy_domains") {
    return host ? `Buy cover for ${host}` : action.title;
  }
  return action.title;
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
    "listIsolationActions" | "getDomainHistory"
  >,
  action: IsolationActionRecord,
): boolean {
  if (action.status !== "pending") return false;
  if (!isBurnAskKind(action.kind)) return false;
  const host = domainOf(action.detail);
  if (host && domainAlreadyRetired(store, host)) return false;
  if (host && retireAlreadySettled(store, host)) return false;
  if (host && domainRetireReplacementSpent(store, host)) return false;
  return true;
}

export function collectPendingSpendItems(
  store: Pick<
    StateStore,
    | "listIsolationActions"
    | "listSpendApprovals"
    | "getDomainHistory"
    | "upsertIsolationAction"
  >,
): SpendDigestItem[] {
  dismissRetiredDomainAsks(store);
  healStaleBurnAsks(store);

  const items: SpendDigestItem[] = [];
  const seen = new Set<string>();

  for (const action of store.listIsolationActions()) {
    if (!isSpendDigestKind(action.kind)) continue;
    if (!isolationStillPending(store, action)) continue;
    const client = clientOfIsolation(action);
    const host = domainOf(action.detail);
    const dedupe = `${action.kind}:${host || action.id}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    items.push({
      source: "isolation",
      id: action.id,
      kind: action.kind,
      label: isolationLabel(action),
      domain: host || undefined,
      clientKey: client.clientKey,
      clientName: client.clientName,
      requestedAt: action.requestedAt,
    });
  }

  for (const record of store.listSpendApprovals()) {
    if (record.status !== "pending" || !isSpendDigestKind(record.kind)) continue;
    const host = domainOf(record.detail);
    const dedupe = `${record.kind}:${host || record.id}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const client = clientOfSpend(record);
    items.push({
      source: "spend",
      id: record.id,
      kind: record.kind,
      label: spendLabel(record),
      domain: host || undefined,
      clientKey: client.clientKey,
      clientName: client.clientName,
      requestedAt: record.requestedAt,
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
  >,
): { groups: SpendDigestClientGroup[]; text: string | null; items: number } {
  const items = collectPendingSpendItems(store);
  const groups = groupSpendItemsByClient(items);
  return { groups, text: spendDigestText(groups), items: items.length };
}
