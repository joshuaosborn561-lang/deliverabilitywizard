/**
 * D230 — a generic attaches to ONE client and ONE POD.
 * min40 may take only an untagged pool seat, or one already on
 * that same client and POD. Never take another client's generic.
 * Never move a tagged generic onto the other POD.
 */

import type { GenericAssignedPod, GenericSeatRecord } from "./genericPool.js";
import { podFromMailboxTags } from "./genericPool.js";

export const GENERIC_POD_TAG_A = "POD-A";
export const GENERIC_POD_TAG_B = "POD-B";
export const GENERIC_POD_TAG_COLOR_A = "#4FC3F7";
export const GENERIC_POD_TAG_COLOR_B = "#9575CD";

export function genericPodTagName(pod: GenericAssignedPod): string {
  return pod === "B" ? GENERIC_POD_TAG_B : GENERIC_POD_TAG_A;
}

export function genericPodTagColor(pod: GenericAssignedPod): string {
  return pod === "B" ? GENERIC_POD_TAG_COLOR_B : GENERIC_POD_TAG_COLOR_A;
}

export function lockedGenericPod(input: {
  tags?: Array<{ tag_name?: unknown; name?: unknown }> | string[] | null;
  assignedPod?: GenericAssignedPod | null;
}): GenericAssignedPod | null {
  return podFromMailboxTags(input.tags) ?? input.assignedPod ?? null;
}

/**
 * True when this generic may be assigned to `clientId` + `targetPod`.
 * Untagged + unassigned pool seats may take any short POD.
 * A seat already on this client and this POD may stay / share.
 * Any other client or the other POD is a hard no.
 */
export function genericEligibleForClientPod(input: {
  clientId: number;
  targetPod: GenericAssignedPod;
  mailboxClientId?: number | null;
  assignedClientId?: number | null;
  tags?: Array<{ tag_name?: unknown; name?: unknown }> | string[] | null;
  assignedPod?: GenericAssignedPod | null;
}): boolean {
  const owner = input.assignedClientId ?? input.mailboxClientId ?? null;
  if (owner != null && owner !== input.clientId) return false;
  const pod = lockedGenericPod({
    tags: input.tags,
    assignedPod: input.assignedPod,
  });
  if (pod != null && pod !== input.targetPod) return false;
  return true;
}

/** Oldest assignment first, then email. That is the D230 return order. */
export function rankGenericsOldestWorstFirst<T extends Pick<GenericSeatRecord, "email" | "assignedAt">>(
  seats: T[],
): T[] {
  return [...seats].sort((a, b) => {
    const aAt = Date.parse(a.assignedAt ?? "") || 0;
    const bAt = Date.parse(b.assignedAt ?? "") || 0;
    if (aAt !== bAt) return aAt - bAt;
    return a.email.localeCompare(b.email);
  });
}

export function stampMailboxPodTag(
  tags: Array<{ tag_name?: unknown; name?: unknown }> | string[] | null | undefined,
  pod: GenericAssignedPod,
): Array<{ tag_name: string }> {
  const existing = lockedGenericPod({ tags });
  if (existing != null && existing !== pod) {
    // D234 — never flip an already-tagged seat. Keep the lock.
    return (tags ?? [])
      .map((tag) =>
        typeof tag === "string"
          ? tag.trim()
          : String(tag.tag_name ?? tag.name ?? "").trim(),
      )
      .filter(Boolean)
      .map((tag_name) => ({ tag_name }));
  }
  const keep = (tags ?? [])
    .map((tag) =>
      typeof tag === "string"
        ? tag.trim()
        : String(tag.tag_name ?? tag.name ?? "").trim(),
    )
    .filter(
      (name) =>
        name &&
        name.toUpperCase() !== GENERIC_POD_TAG_A &&
        name.toUpperCase() !== GENERIC_POD_TAG_B &&
        name.toUpperCase() !== "POD A" &&
        name.toUpperCase() !== "POD B",
    );
  return [...keep.map((tag_name) => ({ tag_name })), { tag_name: genericPodTagName(pod) }];
}

export function stripMailboxPodTags(
  tags: Array<{ tag_name?: unknown; name?: unknown }> | string[] | null | undefined,
): Array<{ tag_name: string }> {
  return (tags ?? [])
    .map((tag) =>
      typeof tag === "string"
        ? tag.trim()
        : String(tag.tag_name ?? tag.name ?? "").trim(),
    )
    .filter(
      (name) =>
        name &&
        name.toUpperCase() !== GENERIC_POD_TAG_A &&
        name.toUpperCase() !== GENERIC_POD_TAG_B &&
        name.toUpperCase() !== "POD A" &&
        name.toUpperCase() !== "POD B",
    )
    .map((tag_name) => ({ tag_name }));
}
