/**
 * D228 — inventory is 40 staffable on POD-A and 40 on POD-B per
 * client. Campaigns link only the on-week POD. The off-week POD
 * keeps assigned generics (client_id, POD tag, signature) with no
 * campaign links. Surplus is generics beyond 40 in THAT POD.
 */

import { GENERIC_POOL_POD_FLOOR, podFromMailboxTags } from "./genericPool.js";
import { onWeekCohort, type RestCohort } from "./restCohort.js";
import type { SmartleadEmailAccount } from "../types/index.js";

export const POD_INVENTORY_EACH = GENERIC_POOL_POD_FLOOR;

export function mailboxPodOf(
  account: Pick<SmartleadEmailAccount, "tags">,
): RestCohort | null {
  return podFromMailboxTags(account.tags);
}

/** Tagged off-week POD. Untagged seats are not treated as off-week here. */
export function isOffWeekPodSeat(
  account: Pick<SmartleadEmailAccount, "tags">,
  now: Date = new Date(),
): boolean {
  const pod = mailboxPodOf(account);
  if (!pod) return false;
  return pod !== onWeekCohort(now);
}

/** Off-week tagged generics must not sit on live campaigns. */
export function genericMayLinkToCampaigns(
  account: Pick<SmartleadEmailAccount, "tags">,
  now: Date = new Date(),
): boolean {
  return !isOffWeekPodSeat(account, now);
}

/**
 * A POD-tagged assigned generic that is not surplus stays assigned
 * even with zero campaign links (the off-week inventory cylinder).
 */
export function keepAssignedGenericForPodInventory(input: {
  email: string;
  tags?: Pick<SmartleadEmailAccount, "tags">["tags"];
  idleEmails?: Iterable<string>;
}): boolean {
  if (!podFromMailboxTags(input.tags)) return false;
  const idle = new Set(
    [...(input.idleEmails ?? [])].map((email) => email.trim().toLowerCase()),
  );
  return !idle.has(input.email.trim().toLowerCase());
}

/** How many more generics this POD still needs to reach 40. */
export function podInventoryNeed(
  namedStaffable: number,
  assignedGenerics: number,
): number {
  const named = Number.isFinite(namedStaffable)
    ? Math.max(0, Math.floor(namedStaffable))
    : 0;
  const assigned = Number.isFinite(assignedGenerics)
    ? Math.max(0, Math.floor(assignedGenerics))
    : 0;
  return Math.max(0, POD_INVENTORY_EACH - named - assigned);
}
