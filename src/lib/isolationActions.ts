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
    next.kind !== "buy_isolation_domain" &&
    next.kind !== "add_signature_tag" &&
    existing.status !== "pending"
  ) {
    return false;
  }
  if (next.kind === "swap_copy") {
    // D133 — the tap applies fleet-wide, so one pending ask per word is
    // enough no matter which campaign isolated it.
    return (
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
  if (next.kind === "buy_isolation_domain") {
    // D137 — the rig asks once, ever: any prior answer (including a deny)
    // stands. Josh reverses a deny by saying so, not by being re-asked
    // every monitor pass.
    return true;
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

/**
 * D97 — leftover Add %signature% buttons are retired. The checker writes
 * the tag (D92). A deploy remind must not re-post them.
 */
export function dismissPendingSignatureAsks(
  store: StateStore,
  now = new Date().toISOString(),
): number {
  let dismissed = 0;
  for (const action of store.listIsolationActions()) {
    if (action.kind !== "add_signature_tag") continue;
    if (action.status !== "pending") continue;
    store.upsertIsolationAction({
      ...action,
      status: "denied",
      decidedAt: now,
      decidedBy: "system",
      error: "Signatures write themselves (D92). Slack ask retired (D97).",
    });
    dismissed += 1;
  }
  return dismissed;
}

/** Re-send Slack buttons for pending asks. Does not create or approve anything. */
export async function remindPendingIsolationActions(input: {
  store: StateStore;
  slack: SlackClient;
}): Promise<number> {
  dismissPendingSignatureAsks(input.store);
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
    if (action.kind === "add_signature_tag") continue;
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
