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

/**
 * D146/D148 refinement — a domain retired in the last week keeps bouncing
 * stale pre-retire sends into the ledger; those samples must not re-open
 * a "Retire X" ask for a domain that is already retired (live 22:10Z on
 * 8/27: techevolutionhub.info got a second ask two hours after Josh
 * executed its first).
 */
export function domainRecentlyRetired(
  store: StateStore,
  domain: string,
  now = Date.now(),
): boolean {
  return store.listIsolationActions().some(
    (row) =>
      row.kind === "retire_domain" &&
      row.status === "executed" &&
      String(row.detail.domain ?? "").toLowerCase() === domain.toLowerCase() &&
      now - Date.parse(String(row.executedAt ?? row.decidedAt ?? "")) <
        7 * 24 * 60 * 60 * 1000,
  );
}

export async function requestIsolationAction(input: {
  store: StateStore;
  slack: Pick<SlackClient, "notifyIsolationAction">;
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
  slack: Pick<SlackClient, "notifyIsolationAction">,
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
  slack: Pick<SlackClient, "notifyIsolationAction">;
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

/**
 * D152 — propose a substitute that still does the job of the line and
 * stayed (or should stay) out of spam. Blank delete is a last resort for
 * pure spam tokens (winner / congratulations), never the default for an
 * opener, offer, or CTA the campaign still needs.
 */
export function suggestedCopySwap(element: string): string {
  const trimmed = element.trim();
  const key = trimmed.toLowerCase();
  const synonyms: Record<string, string> = {
    free: "complimentary",
    guaranteed: "we stand behind",
    guarantee: "we stand behind",
    "act now": "when you have a minute",
    "limited time": "when you have a minute",
    "click here": "here",
    "risk-free": "no surprise",
    "risk free": "no surprise",
    // Pure spam tokens — removing them is the edit.
    winner: "",
    winners: "",
    congratulations: "",
  };
  if (Object.prototype.hasOwnProperty.call(synonyms, key)) {
    return synonyms[key]!;
  }

  // Gift / physical-bait openers: keep the greeting job, drop the bait.
  if (
    /\bair\s*pods?\b/i.test(trimmed) ||
    /\bairpods\b/i.test(trimmed) ||
    /\b(pair of|extra|spare).{0,40}\b(tickets?|gift|air\s*pods?)\b/i.test(
      trimmed,
    ) ||
    /\bi('ve| have) got\b.{0,80}\b(for you|with your name)/i.test(trimmed)
  ) {
    return "{Quick note|Had something useful} from our school-district pen-test work.";
  }

  // Closing CTA / softscript gift lines — keep a soft ask, drop the bait.
  if (
    /\b(come either way|are yours either way)\b/i.test(trimmed) ||
    /\bps[-—:].{0,40}\b(air\s*pods?|tickets?|gift)\b/i.test(trimmed)
  ) {
    return "Happy to send the receipts report if useful.";
  }

  // Generic long phrase: do not default to delete — leave a short bridge.
  if (trimmed.length > 40 || /\s/.test(trimmed)) {
    return "Quick note —";
  }
  return "";
}
