import type { ActionKind, IntendedAction } from "../types.js";

export interface PendingIntentQuery {
  kind: ActionKind;
  campaignId?: number;
  accountId?: number;
  email?: string;
  payload?: Record<string, unknown>;
}

export function payloadReason(payload: Record<string, unknown> | undefined): string {
  const reason = payload?.reason;
  return reason == null ? "" : String(reason);
}

export function isIdenticalPending(
  existing: IntendedAction,
  query: PendingIntentQuery,
): boolean {
  if (existing.executed) return false;
  if (existing.kind !== query.kind) return false;
  if ((existing.campaignId ?? null) !== (query.campaignId ?? null)) return false;
  if ((existing.accountId ?? null) !== (query.accountId ?? null)) return false;
  if ((existing.email ?? "") !== (query.email ?? "")) return false;
  return payloadReason(existing.payload) === payloadReason(query.payload);
}
