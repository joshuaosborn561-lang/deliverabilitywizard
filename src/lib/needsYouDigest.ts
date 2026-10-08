/**
 * D248 — weekday ~8am CT Needs you post. Merges the D220 Cayden spend
 * digest: one Approve per client for Cayden spend, Josh-only listed
 * separately. Does not spend.
 */

import {
  collectPendingSpendItems,
  groupSpendItemsByClient,
  type SpendDigestClientGroup,
  type SpendDigestItem,
} from "./spendDigest.js";
import type { IsolationActionRecord } from "../state/isolationState.js";
import type { StateStore } from "../state/store.js";
import {
  NEEDS_YOU_APPROVE_ACTION,
  needsYouConfirmDialog,
} from "./slackConfirmButtons.js";

export const JOSH_ONLY_KINDS = new Set([
  "buy_canary_fleet",
  "buy_isolation_domain",
  "generic_backfill",
]);

export function isJoshOnlyAsk(kind: string): boolean {
  return JOSH_ONLY_KINDS.has(kind);
}

export function isQueuedForNeedsYou(action: IsolationActionRecord): boolean {
  return action.detail.queuedForNeedsYou === true && action.status === "pending";
}

export function collectJoshOnlyItems(
  store: Pick<StateStore, "listIsolationActions">,
): IsolationActionRecord[] {
  return store
    .listIsolationActions()
    .filter(
      (row) =>
        row.status === "pending" &&
        (isJoshOnlyAsk(row.kind) ||
          (row.kind === "swap_copy" && isQueuedForNeedsYou(row))),
    )
    .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
}

export function needsYouText(input: {
  cayden: SpendDigestClientGroup[];
  josh: IsolationActionRecord[];
}): string | null {
  if (!input.cayden.length && !input.josh.length) return null;
  const lines = [
    "*Needs you* — weekday morning. Cayden spend is one approve per client. Josh-only is listed separately.",
    "",
  ];
  if (input.cayden.length) {
    lines.push("*Cayden — one approve per client*");
    for (const group of input.cayden) {
      lines.push(`*${group.clientName}*`);
      for (const item of group.items) {
        lines.push(`• ${item.label}`);
      }
      lines.push("");
    }
  }
  if (input.josh.length) {
    lines.push("*Josh only*");
    for (const row of input.josh) {
      lines.push(`• ${row.title}`);
    }
    lines.push("");
  }
  lines.push(
    "Cayden: tap Approve under a client (Slack will ask you to confirm). That is the only spend tap. Josh items stay Josh-only.",
  );
  return lines.join("\n").trim();
}

export function needsYouCaydenButtons(
  groups: SpendDigestClientGroup[],
): Array<Record<string, unknown>> {
  return groups.slice(0, 5).map((group) => {
    const button: Record<string, unknown> = {
      type: "button",
      text: { type: "plain_text", text: `Approve ${group.clientName}`.slice(0, 75) },
      style: "primary",
      action_id: `${NEEDS_YOU_APPROVE_ACTION}:${group.clientKey}`.slice(0, 255),
      value: group.clientKey,
      confirm: needsYouConfirmDialog(group.clientName),
    };
    return button;
  });
}

export function buildNeedsYouBlocks(input: {
  text: string;
  cayden: SpendDigestClientGroup[];
  josh: IsolationActionRecord[];
}): unknown[] {
  const blocks: unknown[] = [
    { type: "section", text: { type: "mrkdwn", text: input.text } },
  ];
  const cayden = needsYouCaydenButtons(input.cayden);
  if (cayden.length) {
    blocks.push({ type: "actions", elements: cayden });
  }
  return blocks;
}

export function buildNeedsYouDigest(
  store: Pick<
    StateStore,
    | "listIsolationActions"
    | "listSpendApprovals"
    | "getDomainHistory"
    | "upsertIsolationAction"
  >,
): {
  cayden: SpendDigestClientGroup[];
  josh: IsolationActionRecord[];
  items: SpendDigestItem[];
  text: string | null;
  blocks: unknown[] | undefined;
} {
  const items = collectPendingSpendItems(store);
  const cayden = groupSpendItemsByClient(items);
  const josh = collectJoshOnlyItems(store);
  const text = needsYouText({ cayden, josh });
  return {
    cayden,
    josh,
    items,
    text,
    blocks: text ? buildNeedsYouBlocks({ text, cayden, josh }) : undefined,
  };
}

export function isolationIdsForClient(
  items: SpendDigestItem[],
  clientKey: string,
): string[] {
  return items
    .filter((row) => row.clientKey === clientKey && row.source === "isolation")
    .map((row) => row.id);
}
