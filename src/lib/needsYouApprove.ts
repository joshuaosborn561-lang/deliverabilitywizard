/**
 * D294 — Needs-you per-client Approve. Ack is the caller's job (HTTP 200
 * before this runs). This stamps every isolation id approved on the
 * sidecar *before* any Porkbun / InboxKit / Smartlead work, updates the
 * card as it goes, and returns per-item results even when a buy fails.
 */

import { collectPendingSpendItems } from "./spendDigest.js";
import {
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
  const items = collectPendingSpendItems(input.state);
  const ids = resolveNeedsYouIsolationIds({
    items,
    clientKey: parsed.clientKey,
    stampedIds: parsed.ids,
    getAction: (id) => input.state.getIsolationAction(id),
  });
  try {
    await input.state.saveHot();
  } catch (error) {
    console.warn("[slack-interactions] needs-you prune saveHot failed", error);
  }

  if (!ids.length) {
    const text = `Done by ${input.actor.name}: nothing pending for that client.`;
    await input.updateCard(text);
    return { text, failed: false, ids };
  }

  const stamped = await input.isolationExecute.stampApprovals(ids, input.actor);
  await input.updateCard(
    `${input.actor.name} approved ${parsed.clientKey || "that client"} — working ${stamped.length || ids.length} item(s). Results land on this card.`,
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
