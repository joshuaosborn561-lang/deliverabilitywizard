/**
 * D266 — finished / already-satisfied spend rows must leave pendingSpend
 * and stay out of the next morning's digest. Isolation asks that are
 * already retired or already covered are marked executed; leftover
 * pending spendApprovals for those domains are consumed.
 */

import {
  domainAlreadyRetired,
  domainRetireReplacementSpent,
  isBurnAskKind,
  retireAlreadySettled,
} from "./isolationActions.js";
import type { IsolationActionRecord } from "../state/isolationState.js";
import type { SpendApprovalRecord, StateStore } from "../state/store.js";

function domainOf(detail: Record<string, unknown> | undefined): string {
  return String(detail?.domain ?? detail?.retiredDomain ?? "")
    .trim()
    .toLowerCase();
}

function isolationSatisfied(
  store: Pick<StateStore, "listIsolationActions" | "getDomainHistory">,
  action: IsolationActionRecord,
): string | undefined {
  if (action.status !== "pending") return undefined;
  const host = domainOf(action.detail);
  if (!host) return undefined;
  if (action.kind === "retire_domain" && domainAlreadyRetired(store, host)) {
    return "Already retired — stale Retire ask closed (D266).";
  }
  if (action.kind === "buy_domains" && retireAlreadySettled(store, host)) {
    return "Cover already bought or domain already retired — stale Buy ask closed (D266).";
  }
  if (action.kind === "buy_domains" && domainRetireReplacementSpent(store, host)) {
    return "Replacement already spent — stale Buy ask closed (D266).";
  }
  if (
    isBurnAskKind(action.kind) &&
    (action.detail.phase === "complete" ||
      (Array.isArray(action.detail.domains) &&
        (action.detail.domains as unknown[]).length > 0 &&
        action.detail.phase !== "awaiting_purchase"))
  ) {
    return "Buy already finished — pending stamp closed (D266).";
  }
  return undefined;
}

function spendSatisfied(
  store: Pick<
    StateStore,
    "listIsolationActions" | "getDomainHistory" | "listPoolMailboxes"
  >,
  record: SpendApprovalRecord,
): string | undefined {
  if (record.status !== "pending") return undefined;
  const host = domainOf(record.detail);
  if (!host) return undefined;
  if (domainAlreadyRetired(store, host) || retireAlreadySettled(store, host)) {
    return "Domain already retired or cover already bought (D266).";
  }
  if (domainRetireReplacementSpent(store, host)) {
    return "Replacement already spent (D266).";
  }
  const actionId = String(record.detail.actionId ?? "");
  if (actionId) {
    const action = store
      .listIsolationActions()
      .find((row) => row.id === actionId);
    if (
      action &&
      (action.status === "executed" ||
        action.status === "denied" ||
        (action.status === "approved" &&
          Array.isArray(action.detail.domains) &&
          (action.detail.domains as unknown[]).length > 0))
    ) {
      return "Parent ask already finished (D266).";
    }
  }
  const poolHas = store
    .listPoolMailboxes()
    .some((row) => row.domain.toLowerCase() === host);
  if (poolHas && record.kind === "inboxkit_mailbox_purchase") {
    return "Mailboxes already exist on that domain (D266).";
  }
  return undefined;
}

export function pruneSatisfiedPendingSpend(
  store: Pick<
    StateStore,
    | "listIsolationActions"
    | "upsertIsolationAction"
    | "listSpendApprovals"
    | "upsertSpendApproval"
    | "getDomainHistory"
    | "listPoolMailboxes"
  >,
  now = new Date().toISOString(),
): { isolation: number; spend: number } {
  let isolation = 0;
  let spend = 0;
  for (const action of store.listIsolationActions()) {
    const reason = isolationSatisfied(store, action);
    if (!reason) continue;
    store.upsertIsolationAction({
      ...action,
      status: "executed",
      decidedAt: action.decidedAt ?? now,
      decidedBy: action.decidedBy ?? "the wizard",
      executedAt: now,
      error: reason,
    });
    isolation += 1;
  }
  for (const record of store.listSpendApprovals()) {
    const reason = spendSatisfied(store, record);
    if (!reason) continue;
    store.upsertSpendApproval({
      ...record,
      status: "consumed",
      decidedAt: now,
      decidedBy: record.decidedBy ?? "the wizard",
      description: `${record.description} — ${reason}`,
    });
    spend += 1;
  }
  return { isolation, spend };
}

/** After a tap finishes, consume leftover pending spend rows for that item. */
export function markSpendDoneForAsk(
  store: Pick<StateStore, "listSpendApprovals" | "upsertSpendApproval">,
  input: { actionId: string; domain?: string; decidedBy: string },
  now = new Date().toISOString(),
): number {
  const host = String(input.domain ?? "").toLowerCase();
  let n = 0;
  for (const record of store.listSpendApprovals()) {
    if (record.status !== "pending" && record.status !== "approved") continue;
    const recHost = domainOf(record.detail);
    const recAction = String(record.detail.actionId ?? "");
    const match =
      recAction === input.actionId || (host && recHost === host);
    if (!match) continue;
    store.upsertSpendApproval({
      ...record,
      status: "consumed",
      decidedAt: now,
      decidedBy: input.decidedBy,
    });
    n += 1;
  }
  return n;
}
