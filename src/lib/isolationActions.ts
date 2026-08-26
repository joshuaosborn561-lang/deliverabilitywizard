import type { SlackClient } from "../clients/slack.js";
import type {
  IsolationActionKind,
  IsolationActionRecord,
} from "../state/isolationState.js";
import type { StateStore } from "../state/store.js";

export function buildIsolationAction(input: {
  kind: IsolationActionKind;
  title: string;
  proof: string;
  detail: Record<string, unknown>;
  now?: string;
}): IsolationActionRecord {
  const now = input.now ?? new Date().toISOString();
  return {
    id: `${input.kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: input.kind,
    status: "pending",
    title: input.title,
    proof: input.proof,
    detail: input.detail,
    allowed:
      input.kind === "swap_copy" || input.kind === "add_signature_tag"
        ? "owner_or_operator"
        : "owner",
    requestedAt: now,
  };
}

function samePending(
  existing: IsolationActionRecord,
  next: IsolationActionRecord,
): boolean {
  if (existing.kind !== next.kind) return false;
  // buy_canary_fleet and add_signature_tag look at non-pending history
  // (already bought / recently executed / recently denied) in their branches.
  if (
    next.kind !== "buy_canary_fleet" &&
    next.kind !== "add_signature_tag" &&
    existing.status !== "pending"
  ) {
    return false;
  }
  if (next.kind === "swap_copy") {
    return (
      Number(existing.detail.campaignId) === Number(next.detail.campaignId) &&
      String(existing.detail.element ?? "").toLowerCase() ===
        String(next.detail.element ?? "").toLowerCase()
    );
  }
  if (next.kind === "generic_backfill") {
    return (
      Number(existing.detail.campaignId) === Number(next.detail.campaignId) &&
      (existing.status === "pending" ||
        existing.status === "approved" ||
        existing.status === "executed")
    );
  }
  if (next.kind === "add_signature_tag") {
    const key = (action: IsolationActionRecord): string =>
      signatureCampaignIdsOf(action)
        .sort((a, b) => a - b)
        .join(",");
    if (key(existing) !== key(next)) return false;
    if (existing.status === "pending" || existing.status === "approved") {
      return true;
    }
    // Executed: give the hourly sweep a day to see the tag before a fresh
    // ask is allowed (new copy without the tag is a new problem).
    if (existing.status === "executed") {
      const at = Date.parse(existing.executedAt ?? existing.requestedAt);
      return Number.isFinite(at) && Date.now() - at < 24 * 60 * 60 * 1000;
    }
    // Denied: do not nag hourly — one re-ask a week.
    if (existing.status === "denied") {
      const at = Date.parse(existing.decidedAt ?? existing.requestedAt);
      return Number.isFinite(at) && Date.now() - at < 7 * 24 * 60 * 60 * 1000;
    }
    return false;
  }
  if (next.kind === "buy_canary_fleet") {
    return (
      existing.status === "pending" ||
      existing.status === "approved" ||
      existing.status === "executed"
    );
  }
  return (
    String(existing.detail.domain ?? "").toLowerCase() ===
    String(next.detail.domain ?? "").toLowerCase()
  );
}

export async function requestIsolationAction(input: {
  store: StateStore;
  slack: SlackClient;
  action: IsolationActionRecord;
}): Promise<IsolationActionRecord | null> {
  const existing = input.store
    .listIsolationActions()
    .find((row) => samePending(row, input.action));
  if (existing) return null;
  input.store.upsertIsolationAction(input.action);
  await notifyIsolationActionRecord(input.slack, input.action);
  return input.action;
}

export async function notifyIsolationActionRecord(
  slack: SlackClient,
  action: IsolationActionRecord,
): Promise<void> {
  await slack.notifyIsolationAction({
    title: action.title,
    proof: action.proof,
    actionId: action.id,
    kind: action.kind,
    who:
      action.kind === "swap_copy" ? "Josh or Cayden" : "Josh",
  });
}

/** Re-send Slack buttons for pending asks. Does not create or approve anything. */
export async function remindPendingIsolationActions(input: {
  store: StateStore;
  slack: SlackClient;
}): Promise<number> {
  const pending = input.store.pendingIsolationActions();
  const boughtCanary = input.store
    .listIsolationActions()
    .some(
      (row) =>
        row.kind === "buy_canary_fleet" &&
        (row.status === "approved" || row.status === "executed"),
    );
  let posted = 0;
  for (const action of pending) {
    if (action.kind === "buy_canary_fleet" && boughtCanary) continue;
    await notifyIsolationActionRecord(input.slack, action);
    posted += 1;
  }
  return posted;
}

/** D87 — the campaign ids a signature ask covers (single or bulk). */
export function signatureCampaignIdsOf(action: {
  detail: Record<string, unknown>;
}): number[] {
  const ids: number[] = [];
  const single = Number(action.detail.campaignId);
  if (Number.isFinite(single) && single > 0) ids.push(single);
  if (Array.isArray(action.detail.campaignIds)) {
    for (const raw of action.detail.campaignIds) {
      const id = Number(raw);
      if (Number.isFinite(id) && id > 0 && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

/**
 * D85/D87 — campaigns already owned by a live signature ask: pending or
 * approved, executed within a day, or denied within a week. A new ask only
 * covers campaigns outside this set.
 */
export function coveredSignatureCampaigns(
  actions: IsolationActionRecord[],
  nowMs = Date.now(),
): Set<number> {
  const covered = new Set<number>();
  for (const action of actions) {
    if (action.kind !== "add_signature_tag") continue;
    let live = false;
    if (action.status === "pending" || action.status === "approved") {
      live = true;
    } else if (action.status === "executed") {
      const at = Date.parse(action.executedAt ?? action.requestedAt);
      live = Number.isFinite(at) && nowMs - at < 24 * 60 * 60 * 1000;
    } else if (action.status === "denied") {
      const at = Date.parse(action.decidedAt ?? action.requestedAt);
      live = Number.isFinite(at) && nowMs - at < 7 * 24 * 60 * 60 * 1000;
    }
    if (!live) continue;
    for (const id of signatureCampaignIdsOf(action)) covered.add(id);
  }
  return covered;
}

export function suggestedCopySwap(element: string): string {
  const key = element.trim().toLowerCase();
  const synonyms: Record<string, string> = {
    free: "complimentary",
    guaranteed: "included",
    winner: "",
    winners: "",
    congratulations: "",
  };
  return synonyms[key] ?? "";
}
