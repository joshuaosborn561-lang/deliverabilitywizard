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

/**
 * Slack button value: client key + stamped isolation ids (D294).
 *
 * A raw tab does not survive the Slack round-trip. Production taps from
 * 2026-11-05 on logged the whole value in `client=` and `stamped=0`
 * (`generic-pool retire_domain-…,buy_domains-…`), which is the tab folded
 * into a space. v1 uses "|" plus encodeURIComponent so the delimiter is
 * not whitespace. Parsing still accepts a real tab and that folded space.
 */
const NEEDS_YOU_VALUE_PREFIX = "v1|";
const NEEDS_YOU_VALUE_MAX = 2000;
/** `${kind}-${Date.now()}-${base36}` as posted on live Needs-you cards. */
const NEEDS_YOU_ISOLATION_ID = "[a-z][a-z0-9_]*-\\d{10,}-[a-z0-9]+";
const NEEDS_YOU_FOLDED_VALUE = new RegExp(
  `^(.*?)\\s+(${NEEDS_YOU_ISOLATION_ID}(?:\\s*,\\s*${NEEDS_YOU_ISOLATION_ID})*)$`,
);

function splitNeedsYouIds(raw: string): string[] {
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

export function encodeNeedsYouButtonValue(
  clientKey: string,
  isolationIds: string[],
): string {
  const prefix = `${NEEDS_YOU_VALUE_PREFIX}${encodeURIComponent(clientKey)}|`;
  if (prefix.length >= NEEDS_YOU_VALUE_MAX) {
    return prefix.slice(0, NEEDS_YOU_VALUE_MAX);
  }
  const ids: string[] = [];
  for (const id of isolationIds) {
    const trimmed = id.trim();
    if (!trimmed) continue;
    const next = ids.length ? `${ids.join(",")},${trimmed}` : trimmed;
    if (prefix.length + next.length > NEEDS_YOU_VALUE_MAX) break;
    ids.push(trimmed);
  }
  return `${prefix}${ids.join(",")}`;
}

export function parseNeedsYouButtonValue(value: string): {
  clientKey: string;
  ids: string[];
} {
  const raw = String(value ?? "").trim();
  if (raw.startsWith(NEEDS_YOU_VALUE_PREFIX)) {
    const rest = raw.slice(NEEDS_YOU_VALUE_PREFIX.length);
    const bar = rest.indexOf("|");
    if (bar !== -1) {
      const encodedKey = rest.slice(0, bar);
      let clientKey = encodedKey;
      try {
        clientKey = decodeURIComponent(encodedKey);
      } catch {
        clientKey = encodedKey;
      }
      return {
        clientKey: clientKey.trim(),
        ids: splitNeedsYouIds(rest.slice(bar + 1)),
      };
    }
  }
  const tab = raw.indexOf("\t");
  if (tab !== -1) {
    return {
      clientKey: raw.slice(0, tab).trim(),
      ids: splitNeedsYouIds(raw.slice(tab + 1)),
    };
  }
  const folded = NEEDS_YOU_FOLDED_VALUE.exec(raw);
  if (folded) {
    return {
      clientKey: folded[1].trim(),
      ids: splitNeedsYouIds(folded[2]),
    };
  }
  return { clientKey: raw.trim(), ids: [] };
}

/** Client key stamped on `needs_you_approve_client:<clientKey>`. */
export function clientKeyFromNeedsYouActionId(
  actionId: string | undefined,
): string {
  const raw = String(actionId ?? "");
  const prefix = `${NEEDS_YOU_APPROVE_ACTION}:`;
  if (!raw.startsWith(prefix)) return "";
  return raw.slice(prefix.length).trim();
}

export function needsYouCaydenButtons(
  groups: SpendDigestClientGroup[],
): Array<Record<string, unknown>> {
  return groups.slice(0, 5).map((group) => {
    const isolationIds = group.items
      .filter((row) => row.source === "isolation")
      .map((row) => row.id);
    const button: Record<string, unknown> = {
      type: "button",
      text: { type: "plain_text", text: `Approve ${group.clientName}`.slice(0, 75) },
      style: "primary",
      action_id: `${NEEDS_YOU_APPROVE_ACTION}:${group.clientKey}`.slice(0, 255),
      value: encodeNeedsYouButtonValue(group.clientKey, isolationIds),
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
    | "upsertSpendApproval"
    | "listPoolMailboxes"
    | "getAttachBlock"
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
  const key = clientKey.trim();
  if (!key) return [];
  return items
    .filter((row) => row.clientKey === key && row.source === "isolation")
    .map((row) => row.id);
}

/**
 * Prefer ids stamped on the button so a later regroup (Unassigned →
 * id:123) cannot empty the tap. Live pending / unfinished-approved
 * rows for that client still join in.
 */
export function resolveNeedsYouIsolationIds(input: {
  items: SpendDigestItem[];
  clientKey: string;
  stampedIds?: string[];
  getAction?: (id: string) => IsolationActionRecord | undefined;
}): string[] {
  const stamped = (input.stampedIds ?? []).filter((id) => {
    if (!input.getAction) return true;
    const row = input.getAction(id);
    if (!row) return false;
    if (row.status === "pending") return true;
    return row.status === "approved" && !row.executedAt;
  });
  return [...new Set([...stamped, ...isolationIdsForClient(input.items, input.clientKey)])];
}
