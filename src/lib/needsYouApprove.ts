/**
 * D294 — Needs-you per-client Approve. Ack is the caller's job (HTTP 200
 * before this runs). This stamps every isolation id approved on the
 * sidecar *before* any Porkbun / InboxKit / Smartlead work, updates the
 * card as it goes, and returns per-item results even when a buy fails.
 */

import { collectPendingSpendItems, type SpendDigestItem } from "./spendDigest.js";
import {
  clientKeyFromNeedsYouActionId,
  parseNeedsYouButtonValue,
  resolveNeedsYouIsolationIds,
} from "./needsYouDigest.js";
import type { IsolationActionRecord } from "../state/isolationState.js";
import type { StateStore } from "../state/store.js";

export interface NeedsYouApproveActor {
  name: string;
  role: "owner" | "operator" | "unknown";
}

export interface NeedsYouDecide {
  stampApprovals(
    ids: string[],
    actor: NeedsYouApproveActor,
  ): Promise<string[]>;
  decide(
    actionId: string,
    decision: "approve" | "deny",
    actor: NeedsYouApproveActor,
  ): Promise<{ ok: boolean; message: string }>;
}

export function needsYouApproveLogLine(input: {
  clientKey: string;
  actor: string;
  role: string;
  stamped: number;
  ids: number;
}): string {
  return `[slack-interactions] needs-you approve client=${input.clientKey || "(empty)"} actor=${input.actor} role=${input.role} stamped=${input.stamped} ids=${input.ids}`;
}

export function needsYouApproveAppliedNothingLog(input: {
  clientKey: string;
  pending: number;
  reason: "unresolved" | "none-pending";
}): string {
  return `[slack-interactions] needs-you approve applied nothing client=${input.clientKey || "(empty)"} pending=${input.pending} reason=${input.reason}`;
}

/** Isolation rows the next digest would still list for this client. */
export function pendingIsolationForClient(
  items: SpendDigestItem[],
  clientKey: string,
): SpendDigestItem[] {
  const key = clientKey.trim();
  if (!key) return [];
  return items.filter((row) => row.clientKey === key && row.source === "isolation");
}

/**
 * Empty tap. A client that still has pending isolation rows must not be
 * rewritten to "nothing pending" — that was the false Done card.
 */
export function needsYouEmptyTapResult(input: {
  actorName: string;
  clientKey: string;
  pending: number;
}): { text: string; failed: boolean; updateCard: boolean; log: string } {
  const pending = input.pending;
  const log = needsYouApproveAppliedNothingLog({
    clientKey: input.clientKey,
    pending,
    reason: pending > 0 ? "unresolved" : "none-pending",
  });
  if (pending > 0) {
    return {
      text: `Approve did not apply for ${input.clientKey || "that client"}. ${pending} item(s) still pending.`,
      failed: true,
      updateCard: false,
      log,
    };
  }
  return {
    text: `Done by ${input.actorName}: nothing pending for that client.`,
    failed: false,
    updateCard: true,
    log,
  };
}

export async function handleNeedsYouApproveClient(input: {
  actor: NeedsYouApproveActor;
  buttonValue: string;
  actionId?: string;
  state: Pick<
    StateStore,
    | "listIsolationActions"
    | "listSpendApprovals"
    | "getDomainHistory"
    | "upsertIsolationAction"
    | "upsertSpendApproval"
    | "listPoolMailboxes"
    | "getIsolationAction"
    | "saveHot"
    | "getAttachBlock"
  >;
  isolationExecute: NeedsYouDecide;
  updateCard: (text: string) => Promise<void>;
  stripAsk?: (input: {
    actionId: string;
    kind: string;
    decision: "approve";
    resolvedBy: string;
    detail: string;
  }) => Promise<void>;
}): Promise<{ text: string; failed: boolean; ids: string[] }> {
  const parsed = parseNeedsYouButtonValue(input.buttonValue);
  let clientKey = parsed.clientKey;
  const stampedIds = parsed.ids;
  if (!stampedIds.length) {
    const fromAction = clientKeyFromNeedsYouActionId(input.actionId);
    if (fromAction) clientKey = fromAction;
  }
  const items = collectPendingSpendItems(input.state);
  const ids = resolveNeedsYouIsolationIds({
    items,
    clientKey,
    stampedIds,
    getAction: (id) => input.state.getIsolationAction(id),
  });
  try {
    await input.state.saveHot();
  } catch (error) {
    console.warn("[slack-interactions] needs-you prune saveHot failed", error);
  }

  if (!ids.length) {
    // Live isolation rows for this client are already unioned into ids.
    // If any are still pending while ids is empty, leave the card alone.
    const pending = pendingIsolationForClient(items, clientKey);
    const outcome = needsYouEmptyTapResult({
      actorName: input.actor.name,
      clientKey,
      pending: pending.length,
    });
    if (outcome.failed) console.warn(outcome.log);
    else console.log(outcome.log);
    if (outcome.updateCard) await input.updateCard(outcome.text);
    return { text: outcome.text, failed: outcome.failed, ids };
  }
  if (!stampedIds.length) {
    console.log(
      `[slack-interactions] needs-you approve client=${clientKey || "(empty)"} via=action_id applying=${ids.length}`,
    );
  }

  const stamped = await input.isolationExecute.stampApprovals(ids, input.actor);
  await input.updateCard(
    `${input.actor.name} approved ${clientKey || "that client"} — working ${stamped.length || ids.length} item(s). Results land on this card.`,
  );

  const messages: string[] = [];
  let failed = false;
  for (const id of ids) {
    const result = await input.isolationExecute.decide(id, "approve", input.actor);
    messages.push(result.message);
    if (!result.ok) failed = true;
    const ask: IsolationActionRecord | undefined = input.state.getIsolationAction(id);
    if (input.stripAsk) {
      await input.stripAsk({
        actionId: id,
        kind: ask?.kind ?? "retire_domain",
        decision: "approve",
        resolvedBy: input.actor.name,
        detail: result.message,
      });
    }
    await input.updateCard(messages.join("\n"));
  }
  const text =
    messages.join("\n") ||
    `Done by ${input.actor.name}: nothing pending for that client.`;
  await input.updateCard(text);
  return { text, failed, ids };
}
