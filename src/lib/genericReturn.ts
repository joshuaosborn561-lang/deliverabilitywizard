/**
 * D235 — a generic carries a client and POD tag only while staffed.
 * Returning it to the untagged pool clears client_id, signature, and
 * POD-A/POD-B, and records released_at. D234 still forbids A↔B on a
 * staffed seat and forbids any POD write on a named seat.
 */

import type { SmartleadClient } from "../clients/smartlead.js";
import type { SmartleadAccountWithCampaigns } from "../clients/smartlead.js";
import { hasPoolMarkerTag } from "./markerClients.js";
import {
  GENERIC_POD_TAG_A,
  GENERIC_POD_TAG_B,
  GENERIC_POD_TAG_COLOR_A,
  GENERIC_POD_TAG_COLOR_B,
  stripMailboxPodTags,
} from "./genericAssign.js";
import { existingPodTag } from "./podTagLock.js";
import type { StateStore } from "../state/store.js";

export function mayStripPodTagOnGenericReturn(account: {
  tags?: Array<{ tag_name?: unknown; name?: unknown }> | string[] | null;
}): boolean {
  const tags = (account.tags ?? []).map((tag) =>
    typeof tag === "string" ? { tag_name: tag } : tag,
  );
  return hasPoolMarkerTag({ tags });
}

export async function returnGenericToUntaggedPool(input: {
  smartlead: Pick<SmartleadClient, "updateEmailAccount"> &
    Partial<Pick<SmartleadClient, "ensureTag" | "removeTags">>;
  state: StateStore;
  account: SmartleadAccountWithCampaigns;
  email: string;
  reason: string;
  now?: Date;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!mayStripPodTagOnGenericReturn(input.account)) {
    return { ok: false, reason: "named" };
  }
  const { account, email, smartlead, state, reason, now } = input;
  if (typeof account.id !== "number") {
    return { ok: false, reason: "no_account_id" };
  }
  const clientId =
    typeof account.client_id === "number" ? account.client_id : null;
  const pod =
    existingPodTag(account.tags) ?? state.getGenericSeat(email)?.assignedPod ?? null;

  await smartlead.updateEmailAccount(account.id, {
    client_id: null,
    signature: "",
  });
  if (smartlead.ensureTag && smartlead.removeTags) {
    const tagA = await smartlead.ensureTag(
      GENERIC_POD_TAG_A,
      GENERIC_POD_TAG_COLOR_A,
    );
    const tagB = await smartlead.ensureTag(
      GENERIC_POD_TAG_B,
      GENERIC_POD_TAG_COLOR_B,
    );
    await smartlead.removeTags([account.id], [tagA.id, tagB.id]);
  }
  account.tags = stripMailboxPodTags(account.tags);
  account.client_id = null;
  account.signature = "";

  const pool = state.getPoolMailbox(email);
  if (pool) {
    state.upsertPoolMailbox({
      ...pool,
      assignedClientId: undefined,
      assignedClientName: undefined,
      assignedAt: undefined,
      status: pool.status === "assigned" ? "available" : pool.status,
    });
  }
  if (!state.getGenericSeat(email)) {
    state.ensureGenericSeat({
      email,
      slAccountId: account.id,
    });
  }
  const seat = state.getGenericSeat(email);
  if (seat && seat.assignedClientId == null) {
    seat.assignedClientId = clientId;
    seat.assignedPod = seat.assignedPod ?? pod;
  }
  state.releaseGenericFromTable(email, { reason, now });
  return { ok: true };
}
