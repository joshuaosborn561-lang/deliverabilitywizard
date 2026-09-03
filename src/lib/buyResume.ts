/**
 * D174 — a replacement buy that failed after inboxes were pulled
 * must stay reachable. `awaiting_purchase` is the retryable phase
 * the resume path actually picks up; `approved` with no domain and
 * no phase is the production-stuck shape this heals.
 */
import type { IsolationActionRecord } from "../state/isolationState.js";

export const AWAITING_PURCHASE = "awaiting_purchase";
export const AWAITING_MAILBOXES = "awaiting_mailboxes";

export function purchasedDomainsOf(
  action: Pick<IsolationActionRecord, "detail">,
): string[] {
  return Array.isArray(action.detail.domains)
    ? (action.detail.domains as unknown[]).map((row) => String(row)).filter(Boolean)
    : [];
}

export function isBuyKind(
  kind: IsolationActionRecord["kind"],
): kind is "buy_domains" | "buy_isolation_domain" {
  return kind === "buy_domains" || kind === "buy_isolation_domain";
}

/** True when resume must retry the Porkbun purchase (no domain yet). */
export function needsPurchaseRetry(action: IsolationActionRecord): boolean {
  if (!isBuyKind(action.kind)) return false;
  if (
    action.status !== "approved" &&
    action.status !== "executed" &&
    action.status !== "failed"
  ) {
    return false;
  }
  if (action.detail.phase === AWAITING_PURCHASE) return true;
  if (purchasedDomainsOf(action).length > 0) return false;
  const phase = String(action.detail.phase ?? "");
  return phase !== "complete" && phase !== AWAITING_MAILBOXES;
}

/** True when resume should keep ordering mailboxes on a bought domain. */
export function needsMailboxResume(action: IsolationActionRecord): boolean {
  if (!isBuyKind(action.kind)) return false;
  if (action.status !== "approved" && action.status !== "executed") return false;
  return (
    action.detail.phase === AWAITING_MAILBOXES &&
    purchasedDomainsOf(action).length > 0
  );
}

export function isRetryableReplacementBuy(action: IsolationActionRecord): boolean {
  return needsPurchaseRetry(action) || needsMailboxResume(action);
}

export function retryableBuyReason(action: IsolationActionRecord): string {
  const error = String(action.error ?? action.detail.retryReason ?? "").trim();
  if (error) return error;
  if (needsPurchaseRetry(action)) {
    return "Replacement buy has no purchased domain yet — I will retry (D174).";
  }
  return "Waiting on nameservers / mailbox order.";
}
