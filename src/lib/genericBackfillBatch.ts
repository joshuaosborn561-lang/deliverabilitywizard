/**
 * D205 — one Slack message for a burst of generic_backfill asks
 * instead of one card per campaign. One isolation action carries
 * every campaign id so a single Allow tap covers the burst.
 */

import type { SlackClient } from "../clients/slack.js";
import type { IsolationActionRecord } from "../state/isolationState.js";
import type { StateStore } from "../state/store.js";
import {
  buildIsolationAction,
  requestIsolationAction,
} from "./isolationActions.js";

export interface GenericBackfillAskItem {
  campaignId: number;
  campaignName: string;
  proof?: string;
}

export function genericBackfillCampaignIds(
  detail: Record<string, unknown> | undefined,
): number[] {
  if (!detail) return [];
  const many = detail.campaignIds;
  if (Array.isArray(many)) {
    const ids = many
      .map((n) => Number(n))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (ids.length) return [...new Set(ids)];
  }
  const one = Number(detail.campaignId);
  return Number.isFinite(one) && one > 0 ? [one] : [];
}

export function campaignsAlreadyCovered(
  store: Pick<StateStore, "listIsolationActions">,
  campaignId: number,
): boolean {
  return store.listIsolationActions().some((row) => {
    if (row.kind !== "generic_backfill") return false;
    if (
      row.status !== "pending" &&
      row.status !== "approved" &&
      row.status !== "executed"
    ) {
      return false;
    }
    return genericBackfillCampaignIds(row.detail).includes(campaignId);
  });
}

export async function requestGenericBackfillAsks(input: {
  store: StateStore;
  slack: Pick<SlackClient, "notifyIsolationAction" | "notifyGenericBackfillBatch">;
  items: GenericBackfillAskItem[];
  batch?: boolean;
}): Promise<IsolationActionRecord[]> {
  const unique = new Map<number, GenericBackfillAskItem>();
  for (const item of input.items) {
    if (!Number.isFinite(item.campaignId) || item.campaignId <= 0) continue;
    if (campaignsAlreadyCovered(input.store, item.campaignId)) continue;
    unique.set(item.campaignId, item);
  }
  const items = [...unique.values()];
  if (!items.length) return [];

  const batch = input.batch !== false && items.length > 1;
  if (!batch) {
    const item = items[0]!;
    const action = await requestIsolationAction({
      store: input.store,
      slack: input.slack,
      action: buildIsolationAction({
        kind: "generic_backfill",
        title: `Generics on ${item.campaignName}`,
        proof:
          item.proof ??
          `Pool generics are attached to #${item.campaignId} ${item.campaignName}. Floor stays the on-week client pod (D193/D196/D205). Tap Allow generics if they should stay.`,
        detail: {
          campaignId: item.campaignId,
          campaignName: item.campaignName,
          campaignIds: [item.campaignId],
        },
      }),
    });
    return action ? [action] : [];
  }

  const names = items.map((item) => item.campaignName);
  const ids = items.map((item) => item.campaignId);
  const action = buildIsolationAction({
    kind: "generic_backfill",
    title: `Allow generics on ${items.length} campaigns`,
    proof: items
      .map(
        (item) =>
          `• #${item.campaignId} ${item.campaignName}`,
      )
      .join("\n"),
    detail: {
      campaignId: ids[0],
      campaignName: names[0],
      campaignIds: ids,
      campaignNames: names,
      batched: true,
    },
  });
  input.store.upsertIsolationAction(action);
  const posted = await input.slack.notifyGenericBackfillBatch({
    campaigns: items.map((item) => ({
      id: item.campaignId,
      name: item.campaignName,
    })),
    actionId: action.id,
  });
  const current = input.store.getIsolationAction(action.id) ?? action;
  const stamped: IsolationActionRecord = {
    ...current,
    detail: {
      ...current.detail,
      slackChannel: posted?.channel,
      slackTs: posted?.ts,
    },
    lastNotifiedAt: new Date().toISOString(),
  };
  input.store.upsertIsolationAction(stamped);
  return [stamped];
}
