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
    allowed: input.kind === "swap_copy" ? "owner_or_operator" : "owner",
    requestedAt: now,
  };
}

function samePending(
  existing: IsolationActionRecord,
  next: IsolationActionRecord,
): boolean {
  if (existing.kind !== next.kind || existing.status !== "pending") return false;
  if (next.kind === "swap_copy") {
    return (
      Number(existing.detail.campaignId) === Number(next.detail.campaignId) &&
      String(existing.detail.element ?? "").toLowerCase() ===
        String(next.detail.element ?? "").toLowerCase()
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
  await input.slack.notifyIsolationAction({
    title: input.action.title,
    proof: input.action.proof,
    actionId: input.action.id,
    kind: input.action.kind,
    who: input.action.kind === "swap_copy" ? "Josh or Cayden" : "Josh",
  });
  return input.action;
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
